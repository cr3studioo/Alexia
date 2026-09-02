# comfyui_engine_plan.md

**Local media generation as something Alexia owns, rather than something it can talk to.**

*Written 2026-09-01, the same day [`comfyui_plan.md`](./comfyui_plan.md) was built as `M8-5`.
Revised the same evening after twenty-four questions and a plan approval.*

> **What this is now.** `comfyui_plan.md` shipped *running a workflow somebody already built*.
> This is what comes after: **the plugin as a product, and workflows as sub-plugins.** §8 is the
> idea the whole thing turns on, §11 is the decision that makes it possible, §12 is why this is
> mostly a **core** project rather than a plugin one, and §15 is the twenty-four answers
> everything else is downstream of.

---

## 0. What this document is — and is not

[`comfyui_plan.md`](./comfyui_plan.md) asked *how does Alexia run a workflow somebody already
built.* That shipped this morning. **This asks a bigger question: what if the person has never
opened ComfyUI at all?**

- **It does not schedule anything.** When this becomes work it becomes `D`-numbers and tasks in
  [`plan.md`](./plan.md), the same as `M8-5` did.
- **It is honest about what it costs.** §10 is the part that argues with the rest of the
  project, and it is not buried.
- **Every mechanism is sourced** to a route handler, a file and a line, in this repo or in the
  ComfyUI 0.27.0 install it was read against. Four things were measured on a running server
  rather than read; those say so.

> **Read order:** §2 is the vision. §4 is what has to be true for it. §7 and §8 are the two
> hard builds. §10 is what it costs. §13 is the risk list. §15 is what still needs answering.

---

## 1. Sources

| Source | What it gave | How |
|---|---|---|
| `GET /system_stats` | `vram_total` 8,585,216,000, `ram_total` 17.1 GB, `cuda:0 NVIDIA GeForce RTX 4060 Ti`, torch `2.13.0+cu130` | **Measured**, live |
| `main.py:437`, `comfy_execution/progress.py:184`, `execution.py:494` | The three websocket progress messages and their exact payloads | Source read |
| `custom_nodes/ComfyUI-Manager/glob/*.py` | 40 HTTP routes, including model and node-pack installation | Source read |
| `docs/spec/ui-schema.md:266` | The `graph` widget: `id`, `label`, `links`, `mark`, force layout | Ground truth |
| `plugins/media/*` | The plugin as it stands after `M8-5` | Ground truth |
| The install on this machine | venv 5.5 GB, models **109.5 GB**, custom_nodes 0.9 GB, 26 packs | **Measured** |
| `Alexia.md` — *First run, end to end*, *The four founding goals* | The two-minute claim this plan strains | Ground truth |

---

## 2. The vision, as stated

> *"the user installs alexia. the user picks from the plugin page that they want local comfyui
> integration. it would install all the things needed and then give them like one pre made
> workflow = prompt goes in, image goes out. When the plugin is installing it would check the
> users ram and vram and based on that give them small, mid or high ai image model in that one
> workflow."*
> — the owner, 2026-09-01

And three journeys, in the owner's own numbering:

1. **"create an image of a sunshine"** → Alexia runs the workflow → the person watches it run,
   with the real percentage, *the same as in ComfyUI's browser* → the picture arrives in the
   chat. **The percentage is only in the app**; over Telegram you get the output alone.
2. **"an image of an anime girl"** → the same, but Alexia knows to reach for an anime model and
   to write anime tags.
3. **anything else** → Alexia checks its plugins and skills, finds nothing, asks the ComfyUI
   plugin, looks through the workflows it has; if one fits it runs it, and if none does it
   searches, asks permission, installs, and runs it against the original request.

**Restated as the thing that is actually new.** Today the plugin is a *client*: it assumes
ComfyUI, assumes a checkpoint, assumes the person built the graph. The vision makes it a
*product*: it installs, it chooses a model for the machine it is on, it ships something that
works out of the box, and it grows.

---

## 3. What is already true, after `M8-5`

Worth stating precisely, because more of this exists than it looks.

| Vision needs | Today | Gap |
|---|---|---|
| Run a workflow with its own knobs | ✅ `run_workflow`, title-bound fields | — |
| List what workflows exist | ✅ `workflows` | — |
| Add a workflow | ✅ `add_workflow` | It takes a file the person exported |
| Start ComfyUI when needed | ✅ `launch.js`, five-minute idle stop | It must already be installed |
| Prompt in, image out | ✅ `generate` | The graph is a **literal in code**, not a workflow file |
| Progress | ⚠️ whole images only, by polling `/history` | No step count, no node, no preview |
| Pick a model | ⚠️ by filename, from whatever is installed | Nothing downloads |
| A picture reaches Telegram | ✅ D122 | — |
| Install the engine | ❌ | §5 |
| Choose a model for this machine | ❌ | §6 |
| Watch the graph run | ❌ | §7 |
| Find a workflow nobody has | ❌ | §8 |

**The one to notice is `generate`.** Its graph is built by `comfy.js:26` in JavaScript. The
vision's *"one pre made workflow"* is the same thing expressed as a file — which means the two
paths can become one, and the premade workflow stops being a special case.

---

## 4. The three journeys, mechanically

### 4.1 Journey 1 — *create an image of a sunshine*

Everything but the watching exists. What it needs:

- the premade workflow installed into ComfyUI's `workflows/` at plugin-install time (§5.4);
- `generate` re-pointed at it instead of at the literal graph (§3);
- the websocket, for the percentage (§7).

### 4.2 Journey 2 — *an anime girl*

**This is not a plugin feature. It is a skill, and that is the good news.**

Alexia already separates *capability* from *know-how*: plugins add tools, skills add how to use
them well (`Alexia.md`, *"Whatever you want it to be"*). *Which model suits anime, and that it
wants danbooru tags rather than a sentence* is know-how about a tool that already exists.

So journey 2 is: `generate` gains a model argument it already has, and a **skill** ships beside
the plugin saying when to reach for which installed model and how to write for it. No new
mechanism at all — `M2-2` built the skills loader and `M4-5` learned skills.

**The catch is that the skill has to talk about models that may not be installed.** A skill
naming `hassakuXLIllustrious` on a machine that has SDXL base is worse than no skill. So the
skill has to be written against *what `models` reports*, not against filenames — which is a
constraint on how it is written, not a feature.

### 4.3 Journey 3 — *anything else*

The longest chain, and the only one with a security surface.

```
person asks for something
   → the model looks at its tools                    (exists — this is just the agent loop)
   → nothing fits                                    (exists — no fallback machinery needed)
   → `workflows` lists what is installed             (exists, M8-5)
   → one fits            → run it                    (exists, M8-5)
   → none fits           → search the catalogue      (§8 — NEW)
                         → ask the person            (exists — the consent ladder, M6-9)
                         → install it                (§8 — NEW, and the risky part)
                         → run it with the original request
```

**Two thirds of this is already the agent loop.** *"Alexia looks at the plugins/skills, doesn't
find anything, so it goes to the comfyui plugin"* does not need a fallback chain built — core
routes capabilities by name with no tiebreak (D124), but the *model* picks tools by reading
them, and a tool called `run_workflow` described as *the whole pipeline its author built* is
already the thing it reaches for when `generate` is too thin.

**What is genuinely new is the catalogue and the install.** §8.

---

## 5. Installing the engine

**Decision: hand off to ComfyUI's own installer (§14, answer 2).**

### 5.1 Why not do it ourselves

The install measured on this machine is **5.5 GB before a single model**, of which PyTorch is
2.7 GB. Building that means choosing a torch wheel against a specific GPU and driver — and
getting it wrong produces an install that starts, loads, and then fails strangely, on somebody
else's machine, with no terminal for them to look at. It is the single most common way this
breaks for people, and ComfyUI ships a desktop installer partly because of it.

The plugin already knows how to *find* an install (`launch.js` — `install`, `search`,
`isInstall`, and the finding that the venv beside the install is the only Python with PyTorch
in it). Finding is cheap and reliable. Building is neither.

### 5.2 The flow

```
[ Local media generation ]                        on the plugin page

  1. "ComfyUI isn't on this machine."   [ Get ComfyUI ]
  2. the button opens their installer; Alexia keeps looking
  3. found → "Found it at C:\…\ComfyUI"
  4. hardware read (§6) → "Your card has 8 GB. Downloading SDXL — 6.5 GB."
  5. premade workflow written into ComfyUI's workflows folder
  6. "Ready. Ask me for a picture."
```

Steps 1 and 3 are an `action` widget and a `status` widget — both already in the twelve, both
already writable by a plugin (`status` is the *only* thing a plugin may write, `host.ts:122`,
and that is exactly what this is).

### 5.3 What "keeps looking" means

`launch.js`'s search, on a timer, reported into the `status` line. It must be honest about
having no idea how far along their installer is — *"waiting for ComfyUI to appear"* is true;
a percentage would be invented.

### 5.4 The premade workflow

Ships inside the plugin folder, written into ComfyUI's `workflows/` over `POST /userdata/{file}`
— the route `add_workflow` already uses. **Two files, not one**: the editor's `.json` so the
person can open and change it, and the `.api.json` beside it so it runs. Which is the first
place the export problem bites again, and §11 is about that.

Its nodes are **titled**, because titles are what `M8-5` binds knobs to. `prompt`,
`negative`, `size`, `model` — the person's first sight of a workflow is one whose fields have
names, which is also the best documentation the title convention could have.

---

## 6. Choosing a model for the machine

### 6.1 The reading is cheap and exact

`GET /system_stats`, measured live on this machine:

```json
{ "devices": [ { "name": "cuda:0 NVIDIA GeForce RTX 4060 Ti : cudaMallocAsync",
                 "type": "cuda", "index": 0,
                 "vram_total": 8585216000, "vram_free": 897129170 } ],
  "system": { "ram_total": 17101475840, "pytorch_version": "2.13.0+cu130" } }
```

`vram_total` is the number the tier turns on. `type` distinguishes `cuda`, `mps` and `cpu`.

**But it needs ComfyUI running to ask**, and the tiering happens *during install*. So there are
two readings and they must agree: a pre-install reading of Alexia's own (on Windows, the GPU
name and adapter memory are a WMI/CIM query), and this one afterwards as the authority. When
they disagree, ComfyUI's is right — it is the thing that will actually allocate.

### 6.2 The tiers

Sized against what the tier has to fit in VRAM alongside its own working set, not against the
file on disk.

| Tier | VRAM | Model class | Roughly | Why |
|---|---|---|---|---|
| **Small** | under 6 GB | SD1.5-class | ~2 GB | Runs on almost anything, including laptops with 4 GB |
| **Mid** | 6–12 GB | SDXL-class | ~6.5 GB | The default. This machine is here |
| **High** | 12 GB and up | Flux-class | 12–24 GB | Better, much slower to fetch, and **licence-encumbered** |

**Two things this table must not hide.** The first is that *high* is not simply *better* — a
Flux-class model on a 12 GB card is slower per picture than SDXL on the same card, and a person
who asked for pictures and got a slideshow will not blame the tier. The second is licensing:
SDXL is OpenRAIL, Flux dev is **non-commercial**. Alexia downloading a model for somebody is
Alexia making a licence decision on their behalf, and the plugin page has to say which licence
it is about to accept. That is §15.2.

### 6.3 Where the model comes from

Two routes and they are not equal.

**ComfyUI-Manager's**, which is installed here and exposes `/externalmodel/getlist` and
`/manager/queue/install_model`, with `/manager/queue/status` for progress. It knows where models
live, puts them in the right folder, and reports progress in a shape somebody already debugged.
**But it is a third-party custom node**, its API carries no stability promise, and depending on
it means the plugin's install path breaks when somebody else refactors.

**Direct download**, which is a URL, a hash, and `net.download` — a capability the manifest does
not yet ask for. More code, no dependency, and the progress bar is ours to draw.

*Recommendation: direct, with the URL and hash in the plugin's own manifest.* An install path
is the least good place to inherit somebody else's breaking change, and the download is the one
piece of this that is genuinely simple.

---

## 7. Watching it run

**Decision: the `graph` widget plus a bar (§14, answer 3).** This is the part of the vision that
is closest to *"the same as in the browser"* and it is worth being precise about how close.

### 7.1 The websocket, which this plugin deliberately did not use

`comfy.js:11` argues for polling over the websocket and the argument was right *for what it was
deciding*: whole-image progress on a twenty-second job does not justify a reconnect story. **The
live percentage overturns it**, because per-step progress is websocket-only. That is a decision
to record rather than a detail — the file's own comment says the websocket "is the upgrade and
it is the only thing that would change here", and this is that upgrade arriving.

### 7.2 The three messages, read off the source

| Message | Payload | Source | What it gives |
|---|---|---|---|
| `progress` | `{value, max, prompt_id, node}` | `main.py:437` | **Step 12 of 28** — the bar |
| `executing` | `{node, display_node, prompt_id}` | `execution.py:494` | Which node is running now |
| `progress_state` | `{prompt_id, nodes: {id: {value, max, state, display_node_id, …}}}` | `comfy_execution/progress.py:184` | **Every node's own bar** — what the browser draws |

**The trap, and it is a one-line trap.** Every one of these is sent with
`server_instance.client_id` as the recipient — messages go **only to the client that queued the
job**. So Alexia must open the socket with the same `client_id` it passes to `POST /prompt`.
Today it passes the literal string `alexia`. Get this wrong and the socket connects, stays
silent, and everything looks like ComfyUI is just slow.

### 7.3 Where it is drawn, and what is honestly lost

`M6-11` added `graph` — the only widget that paints pixels, and it still lets a plugin declare
none of them. A row is `id`, `label`, `links`, `mark`, and every visual decision is core's.

So: **the workflow as nodes, the running one `mark`ed, and a `progress` bar underneath.** In
Alexia's palette, with Alexia's focus ring, reopening nothing.

**Two things are lost and neither should be papered over.**

1. **`mark` is one boolean, so per-node percentages cannot be drawn.** `progress_state` carries
   a bar for every node; the widget can show *which* node, not *how far* each one is. The
   overall bar covers the case that matters — one heavy sampler is where the time goes — but
   this is not literally what the browser shows.
2. **The layout is a force layout, tuned for a relationship graph.** Sixty-three memory notes
   with links between them settle into a readable cloud. **A workflow is a pipeline** — people
   read it left to right, and springs-and-repulsion will draw it as a blob that happens to be
   connected. This is a real mismatch, not a tuning problem, and it is §15.1.

### 7.4 The channel split is already the design

*"the actual percentage is only shown in the app, on telegram we see only the output"* — this is
what already happens and needs nothing. `alexia.progress(ctx, …)` "silently does nothing when
the caller did not ask for progress" (`sdk/src/plugin.ts`), and D122 established that a file
reaches a channel as a photo or a document. Telegram gets the picture; the window gets the bar.

---

## 8. The library, and workflows as sub-plugins

**Decision: a workflow is a sub-plugin, and a plugin's page is the plugins page one level down
(§15, answer 22).**

> *"the user opens alexia, goes to the plugins page where all of the plugins show up, then clicks
> comfyui, and it opens basically the same looking screen (with bentobox style) where each box is
> a workflow. where when you open the box it will open a preview of how the nodes are connected
> together. and maybe also what goes in and what goes out as knobs/inputs."*
> — the owner, 2026-09-01

### 8.1 The idea is recursion, and core already has the component

`packages/ui/src/settings.ts` draws the plugins page: a grid of cards, a page of its own behind
every card, installed ones first, then a labelled row, then the not-installed ones **dimmed**
rather than hidden (D118, D120). The CSS class is already called `bento-label`.

The vision is that same component, applied one level down. And the line that makes it legal is
already written, at `settings.ts:16`:

> **Nothing here names a plugin: every card is whatever is in the folder.**

Generalise that to *whatever the plugin declares* and invariant 1 survives untouched — core
learns the idea of a plugin containing things, and never learns the word *workflow*.

**This is the cheapest possible version of what was asked for**, and it is the reason this
section is short: almost none of it is new drawing. What is new is a contract (§12, C2).

### 8.2 The library already exists, and it is local

This was the single biggest finding of the session, and it replaces the plan's earlier
assumption that a catalogue would have to be built and maintained from nothing.

**The running ComfyUI serves it.** Two endpoints, both reachable with the `net.request` this
plugin already holds, both measured live on this machine:

| Endpoint | Gives | Measured |
|---|---|---|
| `GET /templates/index.json` | ComfyUI's own workflow library — categorised, with a title, description, tags, the models each needs, **how much video memory it wants**, and whether it is open source | **468 workflows** |
| `GET /templates/{name}.json` | One workflow | — |
| `GET /api/workflow_templates` (`app/custom_node_manager.py:96`) | Workflows shipped by the node packs *this machine has installed* | 9 from `comfyui-ollama` alone, plus KJNodes, Qwen-TTS |

There is also a hashed index on disk —
`venv/Lib/site-packages/comfyui_workflow_templates_core/manifest.json` — carrying a `sha256` per
asset, in five bundles: `media-image` 195, `media-other` 104, `media-api` 103, `media-video` 66,
`media-assets-01` 16.

**comfy.org/workflows is the web front of this same set** (626+ there; 484 in this install's
version). So no scraping, no terms-of-service question, no network, and it stays current when
ComfyUI updates. **RunComfy was checked and is not a source**: a closed cloud platform, sign-in
required for everything, no public API, redistribution terms unstated.

### 8.3 Two things about those 484 that shape everything

**They are editor format.** Verified by fetching one: `image_z_image_int8.json` has `nodes` and
`links`, not `class_type`. So **the library is unusable without a converter** — installing one
would otherwise mean the person opens it in ComfyUI and clicks *Export (API)* by hand, every
time. For one workflow that is fine; for a library it is not a feature. This is what turns §11
from a nicety into the load-bearing item of the whole plan.

**And the shelf is far smaller than the headline.** Two numbers in the first draft of this
document were wrong, both read off the local pip manifest rather than the live index, and both
were too flattering. Measured against `/templates/index.json` and the card in this machine:

| | |
|---|---|
| in the catalogue | **468** (not 484) |
| call a paid service | **255** (not 103) — more than half |
| open source | 213 |
| **fit an 8.5 GB card** | **45** |
| of those 45, make images | **4** |

**This changes what the feature is.** *A library of 468* is accurate and misleading at once: five
in six entries disappoint, either by wanting a card the person does not have or a credit card
they did not expect to need. So the catalogue filters on the machine **before** it ranks on the
words, and the sentence it leads with is the count about *your* card rather than the total. What
remains is still worth having — 45 runnable workflows covering background removal, upscaling,
audio, 3D and video utilities — but it is a shelf, not a warehouse, and it must not be sold as
one.

### 8.4 The three tiers, ranked

| Tier | Source | Shown |
|---|---|---|
| **Verified** | Workflows the owner has run and tagged | Highlighted, first |
| **Curated** | The Alexia set, published as GitHub Releases the way plugins are (`scripts/publish.mjs`, D118) | Second |
| **Templates** | ComfyUI's own 484, and whatever installed node packs ship | Last, and free to maintain |

**Why ranking is the feature.** A search returning forty things a person cannot judge has moved
the problem, not solved it. *Somebody I trust ran this one* is the only signal that means
anything to a person who has never opened ComfyUI.

**And a badge must record what it was verified against** — which ComfyUI, which packs at which
versions, which model, on what date — or it rots into authority it has stopped deserving. A
bare tick that means *the owner clicked it once in July* is worse than no tick.

### 8.5 What Alexia does, and it is mostly the agent loop

The owner's own chain:

```
person asks for something
  → the model reads its tools                      (exists — the agent loop)
  → nothing on the plugins page fits               (exists — no fallback machinery needed)
  → the media plugin's installed workflows         (exists, M8-5: `workflows`)
  → one fits           → run it                    (exists, M8-5: `run_workflow`)
  → none fits          → search the library        (NEW — §13)
                       → ask the person            (exists — the consent ladder, M6-9)
                       → install it                (NEW — and §8.6)
                       → run it against the original request
  → still nothing      → the skills page           (exists — skills are already in context)
```

**Only two links in that chain are new.** Core routes capabilities by name with no tiebreak
(D124), but *the model* picks tools by reading them, and a tool described as *the whole pipeline
its author built* is already what it reaches for when the quick door is too thin.

### 8.6 Installing one, and the sharpest edge in this document

A workflow is JSON and harmless. **The node packs it needs are arbitrary Python that runs on the
person's machine with the person's files.**

> Installing a custom node pack is running a stranger's code. There is no sandbox, no review,
> and no undo beyond deleting a folder.

The owner chose **one consent, then trust the catalogue** (§15, answer 17) — asked hard the first
time, silent afterwards. That is the lowest-friction answer and it is the highest-risk decision
in this plan, so the thing that makes it survivable has to be stated as a rule rather than a
preference:

> **Nothing outside a vetted catalogue entry may ever be installed.** Never a free-text search,
> never a pack the model chose, never a URL from a conversation. If a workflow needs something
> not on the list, the answer is a sentence and a link — not an install.

Two supports go with it: the one-time consent must **name that scope** rather than asking for
blanket permission, and the plugin's own page must **list what was installed** with a way to
remove it. A silent tenth install is only acceptable if the ninth is still visible.

### 8.7 Adding your own

A button that explains the export, offers **both** a folder to drop into and a drag-and-drop
zone, and then opens ComfyUI. With §11 in place it takes the editor's own `.json` and the export
click disappears entirely.

The drop zone is a genuinely new affordance (§12, C4) — and notably **not** the thing G7 refused
twice. D89's argument was that *a browser will not tell a page where a file is, so a `path` can
never be filled by picking*. A dropped file yields **bytes**, not a path, and bytes are exactly
what this needs.

---

## 9. The machine with no graphics card

**Decision: dim the local plugin rather than hide it, and say the cloud path is coming
(§14, answer 4, refined 2026-09-01).**

**Nothing in Alexia makes a picture in the cloud.** `image.generate` is declared by exactly one
plugin — `plugins/media` — and `provider.ts` handles images only as *input* (`image_url` parts
on the way to a vision model). There is no image-generation provider, no route for one, and no
model-catalog entry for one. **Connecting an image API is not a small missing piece; it is
unbuilt work**, and §15.6 is about when it happens.

The original draft of this section recommended saying nothing until it exists. The owner asked
for **coming soon** instead, and that is the better answer — for a reason worth writing down:

> *Nothing here* and *not yet* are different sentences, and only one of them is true. A person
> whose laptop has no graphics card is not being told the answer is no; they are being told to
> come back. Withholding that is not caution, it is just less information.

### 9.1 Why this is not the failure D127 was

`M8-5` deleted a hint reading *the list fills in once it can reach ComfyUI*, because the widget
contract made it **impossible** — no amount of waiting would ever have filled that list. This is
a different category: the thing is merely **unbuilt**, and somebody intends to build it. A
statement of intent is honest; a statement of capability would not be.

**Three rules keep it in that category**, and it curdles into D127 the moment any is dropped:

1. **No button.** Nothing to press that does nothing. `[ Set that up ]` pointing at a route that
   does not exist is the exact shape of the thing that was just removed.
2. **Name what is missing, not just the promise.** *"Alexia cannot connect to an image service
   yet"* tells somebody what kind of wait it is. *"Coming soon"* on its own is marketing.
3. **It has an end.** The sentence disappears the day anything provides `image.generate` over a
   network — not by somebody remembering, but because the card asks whether a provider exists
   and says this only while the answer is no. **A coming-soon still on the screen in a year is
   D127 with better manners.**

### 9.2 What the card says

```
  Local image generation                        (dimmed)

  Makes pictures on this machine. Needs a graphics card
  with at least 4 GB — this one has none, so a picture
  would take minutes rather than seconds.

  Making them through a service instead is coming.
  Alexia has no way to connect one yet.
```

**Dimmed rather than hidden**, and D120 already argued this exact distinction for plugins that
are not installed: a greyed control is one you cannot use, and dimming means *here, and not for
you right now*. Hiding it entirely means the first person on a laptop who wonders whether Alexia
makes pictures finds nothing at all and concludes it does not — which is the same information
loss the *coming soon* is there to prevent.

---

## 10. What this costs the rest of the project

The section that argues with `Alexia.md`, put where it cannot be missed.

**The two-minute claim.** *"Double-click, answer two plain questions, and it works."* Combined
mode under two minutes, Local mode about five, "the ceiling is five minutes, and waiting is fine
as long as it is visible." This plugin is **5.5 GB of engine and 6.5 GB of model**. On a normal
connection that is twenty to forty minutes.

**It does not break the claim, and the reason is worth being precise about.** The claim is about
*first run* — installer, name, mode, provider, first conversation. This is a plugin the person
chooses later, from a page, deliberately. The front door is untouched.

**But it does put something on the plugin page that no other card carries**, and the honesty
rule applies before the click, not after:

> **The card must say the size and the time before it is pressed**, in the same sentence as what
> it does. *"Makes pictures on this machine. Needs about 12 GB and half an hour to set up."*
> A progress bar that starts after a person has committed to a thirty-minute download they were
> not told about is the exact failure the five-minute ceiling exists to prevent.

**And one thing genuinely changes.** `Alexia.md` says core owns "anything that downloads" as a
plugin concern, which holds. But the *plugin library* now has entries with wildly different
weights, and a page that lists an 8 KB plugin next to a 12 GB one without saying so is a page
that misleads by omission. That is a plugin-page question, not a ComfyUI one, and it is §15.4.

---

---

## 11. The export problem, and the decision that ends it

`M8-5` chose to consume ComfyUI's API export (D123) and refuse stale ones (D126). The earlier
draft of this plan listed three places that chafes. §8.2 added a fourth and much larger one: a
library of 484 editor-format workflows, every one of which would need a human to open it and
click a menu entry.

**Decision: the `graphToPrompt` bridge goes ahead (§15, answer 21).** A webview loading ComfyUI's
own frontend from the local server, never shown to anyone, used for one call.

What it retires, all at once:

- the export click, for the person's own workflows;
- the staleness refusal (D126), because there is nothing saved to go stale;
- the two-file catalogue entry;
- and the reason the library could not exist.

**What it costs, stated plainly rather than buried.** It reopens what `host.ts:122` and M6-11
closed twice. *"It is only hidden"* is exactly the argument that erodes a boundary, so it does
not arrive as a footnote inside this plan — it gets its own decision, argued on its own terms,
with an explicit rule attached: **it renders nothing, it is never shown, and it exists to answer
one question.** If it ever draws anything a person sees, that is a different decision and it has
not been made.

---

## 12. What has to be built in core

**The finding that should shape how this is sequenced: this is mostly a core project.** Roughly
sixty per cent of the work below is contract and shell rather than plugin. The ComfyUI-specific
half is comparatively small and mostly already written.

Together these take `alexia_protocol` to **5**. `MIN` stays at 2 — seven first-party plugins
declare 2 and use nothing above it, and breaking them to keep a number tidy is tidying rather
than deprecating (the M6-11 argument, unchanged).

| # | Change | Why it is needed | What it stands on |
|---|---|---|---|
| **C1** | **An `image` widget — the thirteenth** | Nothing in the twelve can show a picture. Wanted by the forming preview (§13.3), a workflow's thumbnail (§8), and the Pictures gallery | `graph` was granted at D115 when every alternative was worse, *and its own note is uneasy that it has one user*. This one arrives with **three** |
| **C2** | **A plugin sub-library** | §8.1. A plugin declares items of its own; core renders them the way it already renders plugins | `settings.ts` has the grid, `bento-label`, the installed/not-installed dimming (D118, D120) and a `matches()` filter already |
| **C3** | **A trace entry that can carry a diagram and an image** | §15, answers 20 and 21 — the graph and the forming picture go in the trace, not a new panel. **Generic**, so core never names ComfyUI | `live.ts:288` already renders `progress/total` as a percentage |
| **C4** | **A drop zone** | §8.7. Needs a file's *contents* | D89's refusal inverted: a drop yields bytes, not a path |
| **C5** | **A conversation-ended event** | §15, answer 3 — `/new` frees the graphics card. `newChat` exists at `commands.ts:148`, but core must never name a plugin and the SDK has no such event | The `onSettingsChanged` shape |
| **C6** | **A hidden webview a plugin may own** | §11 | — |

**One of these is free.** C3's percentage half needs *no UI change at all*: `live.ts` already
draws a bar from `progress/total`, and §13.1 only has to feed it real numbers.

---

## 13. The phases

Not a schedule. Ordered so that each phase is useful alone and nothing waits on something later.

### Phase 0 — the two things everything else waits on

**0.1 The `graphToPrompt` bridge** (C6, §11). Without it the library ends in homework, every
time. **Acceptance: take one of the 484, convert it, run it, get a file back, with no human
touching a ComfyUI menu.**

**0.2 Websocket progress.** The socket `comfy.js:11` deliberately avoided — and its own comment
predicted this exact moment: *"the websocket is the upgrade and it is the only thing that would
change here."*

Three messages, read off source rather than documentation:

| Message | Payload | Source |
|---|---|---|
| `progress` | `{value, max, prompt_id, node}` | `main.py:437` |
| `executing` | `{node, display_node, prompt_id}` | `execution.py:494` |
| `progress_state` | `{prompt_id, nodes: {id: {value, max, state, …}}}` | `comfy_execution/progress.py:184` |

**The trap, and it is one line.** Every one is sent to `server_instance.client_id` only — the
client that queued. The socket must connect with the **same** `client_id` passed to
`POST /prompt` (today the literal string `alexia`). Get it wrong and the socket connects, stays
silent, and the whole thing reads as ComfyUI being slow. So the test asserts a message was
**received**, not that a socket opened.

### Phase 1 — the plugin becomes a product

1. **Rename** to *Local media generation*, ComfyUI named in the summary. Id and namespace stay
   `media` — `store.ts:141`, nothing migrates.
2. **`generate` runs the starter workflow file** instead of the graph literal at `comfy.js:26`.
   One definition of the basic pipeline instead of two that drift. Its signature and its
   `image.generate` binding are unchanged.
3. **The install flow** — detect, hand off to ComfyUI's installer, keep looking, report. The
   card **states its size and setup time before it is pressed**.
4. **Tiering and the model download** — `/system_stats` once up, a WMI/CIM reading before it
   exists, ComfyUI's the authority when they disagree. Downloaded into the plugin's own folder,
   with `--extra-model-paths-config` making ComfyUI see it anyway.
5. **The no-GPU card** — dimmed, *coming soon*, under §9's three rules.
6. **Lifecycle** — up once started, down on conversation-ended (C5), uninstall takes everything
   Alexia made and nothing it did not.

### Phase 2 — the sub-plugin library

The sub-library contract (C2), the three-tier catalogue (§8.4), workflow install/enable/delete,
the detail view — which reuses `workflows.js`'s `knobs()` unchanged, because it already extracts
exactly *what goes in and what comes out* — the consent scope (§8.6), and adding your own (§8.7).

### Phase 3 — the watching

The `image` widget (C1), then the graph and the forming preview inside the trace entry (C3),
then the Pictures tab with the folder size on it.

**Two honest limits to settle before building 3.2**, both from `docs/spec/ui-schema.md:266`:
`mark` is one boolean, so *which* node is running can be drawn and *how far each one is* cannot;
and the force layout was tuned against sixty-three memory notes, while a workflow is a pipeline
people read left to right. Second layout mode, stages only, or accept the blob — but decided
first.

### Phase 4 — the finish

Last-run memory so *same but bigger* reuses the seed; VRAM pre-flight; the model-choice skill;
fast defaults with *better* turning the dials up.

---

## 14. Risks

| Risk | Severity | What holds it |
|---|---|---|
| **One consent then silence** means the tenth node-pack install is unremarked, and the tenth is the one nobody thought about | **High** | §8.6's rule is now load-bearing rather than sensible: never outside a vetted entry. Plus the consent naming its scope, and a visible list of what was installed |
| The hidden webview normalises *a plugin may draw, as long as nobody sees it* | **High** | §11 — its own decision, with the render-nothing rule attached |
| `client_id` mismatch: silent, and reads as slowness | **High** | §13, phase 0.2 — the test asserts a message arrived |
| Somebody is committed to 12 GB they were not told about | **High** | §10's card rule: size and time before the press |
| A model is downloaded under a licence nobody saw | **Medium** | Name the licence on the card; never default to a non-commercial model |
| Pictures accumulate unbounded | **Medium** | Chosen knowingly (§15, answer 11). The size goes on the Pictures tab, which is the honest version of not pruning |
| The force layout draws a pipeline as a blob | Medium | Settle before phase 3.2 |
| A verified badge outlives what it was verified against | Medium | §8.4 — record the versions, let it go stale visibly |
| ComfyUI's template index changes shape | Low | It is versioned and hashed; fall back to the curated tier |
| `alexia_protocol` 5 breaks an older plugin | Low | `MIN` stays at 2 |

---

## 15. The answers this plan is built on

Twenty-four, put to the owner with evidence across five rounds. Everything above is downstream
of these.

**Installing.** 1 Models live in Alexia's own folder, with `--extra-model-paths-config` making
ComfyUI see them anyway · 2 A machine that already has ComfyUI downloads nothing · 3 ComfyUI
stays up once started, and `/new` shuts it down · 4 The starter workflow is visible and editable
in the person's own sidebar · 5 Hand off to ComfyUI's installer · 6 Tier on `vram_total`,
defaulting to mid · 7 Download directly, not through ComfyUI-Manager.

**Using it.** 8 Two doors — `generate` quick, `run_workflow` full · 9 Attribution needs no work,
the trace panel already does it · 10 The plugin remembers the last run · 11 Every picture is kept
· 12 Prefer the loaded checkpoint unless the ask implies a style · 13 Fast by default, quality on
request · 14 Pre-flight VRAM, speak only when tight · 15 Queue behind the person's own jobs,
never interrupt.

**Trust.** 16 Local is local; the channel is the boundary · 17 One consent, then trust the
catalogue · 18 Uninstall takes everything Alexia made and nothing it did not.

**Look.** 19 A Pictures tab with the size on it · 20 The graph goes in the trace entry · 21 The
forming image goes there too · 22 Workflows are real sub-plugins — install, disable, delete ·
23 Paid-API templates hidden behind a filter · 24 Renamed *Local media generation*, ComfyUI in
the summary.

**And from the round before.** The catalogue is three ranked tiers, verified first · hand off to
ComfyUI's installer · the graph widget rather than an embedded canvas · a no-GPU machine is
dimmed and told *coming soon*.

---

## 16. What is still open

### 16.1 A pipeline is not a relationship graph
`graph`'s force layout was tuned against sixty-three memory notes and is good at that. A workflow
is a DAG people read left to right. Second layout mode (a core widget changed for one plugin —
the thing M6-11 was careful about), stages only, or accept the blob. **Blocks phase 3.2.**

### 16.2 Which model does a fresh install get, by name, and under which licence?
§6.2 names classes. The default is a decision with a licence attached — SDXL is OpenRAIL, Flux
dev is non-commercial — and Alexia accepting one on somebody's behalf needs a person to have
chosen it. **Owner's call.**

### 16.3 Does the plugin page show weight?
§10. A page listing an 8 KB plugin beside a 12 GB one without saying so misleads by omission.
A plugin-library question that ComfyUI merely exposed first. **Spec question.**

### 16.4 The cloud image path
§9 made this non-blocking — *coming soon* is honest while it does not exist. But when it lands it
is the **second provider of a capability that has only ever had one**, and `plugins.ts:351`
routes by name with no tiebreak (D124). The cheap way out is for it to declare a **different**
capability name and let the model choose by reading two tools, exactly as `run_workflow` already
does. **Argue before building, not during.**

---

## 17. Decisions this plan proposes

None is built. When they are, they become `D129`+ in [`plan.md`](./plan.md).

| # | Proposal | Section |
|---|---|---|
| 1 | Hand off to ComfyUI's installer rather than building an environment | §5 |
| 2 | Tier the model on `vram_total`, three tiers, default mid | §6.2 |
| 3 | Download directly, not through ComfyUI-Manager | §6.3 |
| 4 | Adopt the websocket, overturning `comfy.js:11`, for per-step progress | §13 |
| 5 | The running graph is the `graph` widget in the trace entry, not an embedded canvas | §13 |
| 6 | A no-GPU machine is dimmed and told *coming soon*, under three rules | §9 |
| 7 | The catalogue is three ranked tiers, verified first | §8.4 |
| 8 | **Nothing outside a vetted catalogue entry may ever be installed** | §8.6 |
| 9 | A plugin card states its size and setup time before it is pressed | §10 |
| 10 | `generate` runs the starter workflow file rather than a graph built in code | §13 |
| 11 | Journey 2 is a **skill**, not a plugin feature | §4.2 |
| 12 | **A workflow is a sub-plugin**, and a plugin's page is the plugins page recursed | §8.1 |
| 13 | **The `graphToPrompt` bridge goes ahead**, hidden, rendering nothing | §11 |
| 14 | Models live in the plugin's own folder, surfaced by `--extra-model-paths-config` | §15 |
| 15 | Paid-API templates are hidden behind a filter | §8.3 |
| 16 | Renamed *Local media generation*; id and namespace stay `media` | §15 |

*`M8-5` — the workflow runner all of this builds on — shipped 2026-09-01 and is `D123`–`D128`.*
