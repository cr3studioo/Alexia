# Alexia

> **What this doc is.** The single source of truth for what we are building and why.
> Everything decided lives here. It is updated every time a question gets answered, so
> if this doc and anyone's memory disagree, this doc wins.
>
> Companion files: [`plan.md`](./plan.md) — how it gets built, in what order, and what is
> done so far. [`questions.md`](./questions.md) — the open questions still to work through.
> Answered questions move out of there and into here.
>
> *Where `plan.md` records a decision dated later than this document, the later decision wins
> — and it is copied into the decision log below the same day, so the two never drift.*
>
> Published plan (visual): https://claude.ai/code/artifact/fad22be1-a776-49bb-84d7-64415bb159ed
>
> Started 2026-08-27. Repo: `github.com/cr3studioo/Alexia`.

---

## What Alexia is

An open-source AI assistant built as a **tiny core plus a rack of plugins you can pull
out without breaking anything**.

It exists because of three specific complaints about the alternatives (OpenHands,
Hermes and similar):

1. **They talk, and that is mostly it.** Maybe they open an app. Capability stops there.
2. **They cost money you should not have to spend** — a subscription, an enormous token
   bill, or a closed source tree.
3. **They are monolithic.** A voice feature was once added to a Hermes install and then
   could not be removed without breaking the codebase. Code you did not want, that you
   could not delete.

The third one is the real problem and it dictates the architecture:

> *A feature you cannot remove is not modular, it is permanent.*

### "Whatever you want it to be"

*Clarified 2026-08-27.* This phrase means **capability, not personality**. Not "Alexia can
have any character" — *"Alexia can do anything you throw at it."*

The mechanism is two marketplaces of extensions rather than one:

- **Plugins** add capability — new tools, new integrations, new processes.
- **Skills** add know-how — how to do something well with the tools that already exist.

The claim is not that Alexia ships able to do everything. It is that the gap between
*"Alexia cannot do that yet"* and *"Alexia can do that"* is one install.

### The four founding goals

| # | Goal | Why it is here |
|---|------|----------------|
| 1 | **Dead-easy setup**, including for people who find technical concepts confusing | The competitors all assume a technical user |
| 2 | **Open source** | Two of the three alternatives are not |
| 3 | **Do not pay for what you do not need** — prefer free and local models, and keep the model list current as new free/cheap models ship | Token cost was a direct complaint |
| 4 | **Genuinely modular** — every feature is a folder you can disable or delete | The Hermes voice incident; *this is the main one* |

---

## Who this is for, and what winning looks like

*Decided 2026-08-27.*

### The demo is the setup

Of the four goals, **the one Alexia leads with is setup**. Double-click, answer two plain
questions, and it works. Not the agent loop, not the plugin architecture, not the zero
bill — those are why people *stay*. Setup is why they *start*, and it is the promise every
alternative reliably breaks.

That is a deliberately unflashy pitch, and it is the honest one.

### The two-minute claim, and how it stays true

| Mode | First-run time | Why |
|---|---|---|
| **Combined** (default) | Under two minutes | Nothing to download. This is the demo. |
| **Local** | About five minutes | A model download, with a progress bar the whole way. |

The ceiling is **five minutes, and waiting is fine as long as it is visible.** Silence is
what kills a first run, not time. A progress bar that moves buys far more patience than a
faster process that looks stuck.

> Keep the claim matched to the default. The demo says two minutes because the default mode
> genuinely is two minutes. Local mode's download is an opt-in inside the five-minute
> ceiling, never a surprise in the middle of the two-minute story.

### There is a real person to test on

The target user is **someone specific and known** — not a demographic. That is worth more
than any amount of persona work, because it turns *"would a non-technical person understand
this word?"* from a debate into a question with an answer.

The commitment that follows: **sit them in front of it at every milestone, and do not help.**
Time it. Write down where they hesitate. Ease of setup is a claim that can only be verified
by watching someone struggle, and it gets much cheaper to fix at M1 than at M5.

> **This reorders the roadmap.** If setup is the pitch, then a build that person can
> double-click has to exist long before M5 — see the note in *Roadmap*.

---

## First run, end to end

*Drafted 2026-08-27 from every decision in this document.* Setup **is** the pitch, so it gets
specified here rather than figured out at M5.

| # | Screen | Time |
|---|---|---|
| 1 | **Double-click the installer.** Rough one at M2, signed at M5. | — |
| 2 | **"What should I call you?"** Prefilled `Alexia`, skippable. One field. | 5s |
| 3 | **"How should I run?"** Three cards — *Local* (best privacy, needs a capable machine, ~5 min), *Combined* (**preselected**, ~2 min), *Cloud*. | 15s |
| 4a | *Combined or Cloud:* **connect a provider.** OpenRouter's free tier needs no card; or paste a key you already have; or connect Claude Code if it is installed. | 60s |
| 4b | *Local:* **model download**, with a progress bar that never goes silent. | ~3 min |
| 5 | **First conversation.** Tray icon appears, the hotkey is shown once. | — |

**Steps 1–3, 4a and 5 come in under two minutes.** Step 4b is what pushes Local mode to the
five-minute ceiling, and it is the only step that ever should.

### What deliberately is *not* in first run

- **No account, no email, no sign-up.** Alexia has no user backend at all — the registry
  backend serves plugins, not people. Nothing to create, nothing to verify.
- **No onboarding tour.**
- **No permission questions.** The mode defaults to *Ask before anything risky*, and folder
  access is requested the first time something actually needs it — the way a phone app does.
  Asking someone which folders an assistant may read, before they have given it a single
  task, is a question with no meaning yet. Both remain in settings for anyone who looks.

---

## The load-bearing invariant

> **Delete the folder. Nothing breaks.**
>
> Every plugin is a folder. Remove it while Alexia is running and the only thing that
> changes is that its feature is gone.

Not a guideline — a property the build enforces, verified in CI on every commit.

Most plugin systems fail this because core eventually imports a plugin by name: one
convenience import, one shared type, one hardcoded menu entry, and now the folder is
load-bearing. Five structural rules prevent it:

1. **Core source never names a plugin.** Zero static references, enforced by a lint rule
   and a CI grep over `core/`. If `voice` appears in core, the build fails.
2. **All coupling goes through two channels only** — the `plugin.json` manifest
   (declared, read at boot) and RPC messages (runtime, async). No third channel, no
   shared object, no direct import.
3. **A plugin owns its storage in a namespace it declares.** Its tables, its files, its
   settings keys. Uninstall drops the namespace and deletes the folder — nothing orphaned.
4. **Core boots and passes its full test suite with `plugins/` empty.** A CI job, not an
   aspiration.
5. **Plugins depend on capabilities, never on other plugins.** A notes plugin requires
   `voice.transcribe`, not "the voice plugin". If nothing provides that capability, the
   notes plugin degrades with a message its author wrote, instead of crashing.

> Rule 5 is the one that usually gets skipped, and it is what turns a plugin system into
> a dependency tangle a year in. It goes in the manifest schema at M0, before there are
> two plugins to entangle.

---

## Architecture

**Every plugin runs as its own OS process**, talking to core over a wire protocol. A
plugin that crashes, hangs or leaks memory takes down only its own panel; core stays up
and offers to restart it.

```
        core (main process)
          |-- voice   (own process)   <- mic audio enters here directly, never crosses
          |-- memory  (own process)   <- owns its own tables
          |-- ollama  (own process)   <- holds the model weights
```

### What core owns vs what must be a plugin

| Core — the minimum | Plugin — everything else |
|---|---|
| Sessions and message history | Voice, memory, computer control |
| Settings, secrets in the OS keychain | Local model runners |
| API usage stats and budget caps | Every integration, forever |
| Model catalog and router | Anything holding a credential |
| Plugin supervisor | Anything that downloads |
| Plugin library client | Anything you might not want next year |
| The agent loop and its rails | Every access channel beyond the built-in overlay — Telegram included |
| The tray daemon and the hotkey overlay | Long-term memory and recall across sessions |
| Provider integration *(deliberate exception — see Model providers)* | Claude Code, which wraps an external binary |

> **The test for core:** if it can be expressed through the plugin contract, it must be
> a plugin. Without that line, core accretes one more just-this-once feature every month
> for two years and the thesis quietly dies.

### Transport: JSON-RPC 2.0 over stdio

Not a localhost port. The alternative costs exactly what we are optimising for: on
Windows, binding a port can raise a Defender prompt, and a firewall dialog in front of a
non-technical user is where setup dies. stdio has no ports to collide, no firewall
surface, gives process-death detection for free, and behaves identically on all three
platforms.

> **Refined 2026-08-27 (D50): that protocol already exists, and it is MCP.** The Model
> Context Protocol *is* JSON-RPC 2.0 over stdio, with an `initialize` handshake and version
> negotiation — plus tool listing and calling, progress, cancellation, host-side model calls,
> user prompts, folder roots, and a `tools/list_changed` notification for exactly the case
> where a tool vanishes mid-task. Alexia pins an MCP revision and adds a five-method
> `alexia/*` layer for what MCP does not cover: the manifest, settings, storage namespaces,
> `requires`/`provides`, lifecycle. The payoff is the same one that carried agentskills.io —
> the marketplace starts non-empty, because any of the ~10,000 existing MCP servers works as
> an Alexia tool plugin. Full mapping in [`plan.md`](./plan.md), *The contract*.

### Supervision — and the memory objection

The honest cost of process isolation is memory, roughly 30–60 MB per live plugin. The
supervisor makes that acceptable:

- **Lazy spawn** — a plugin process starts on first use, not at boot. Enabled-but-unused
  costs nothing.
- **Idle shutdown** — no traffic for a few minutes and the process exits, respawning
  transparently on the next call.
- **Restart with backoff** — crash, restart. Three crashes in sixty seconds and it stops
  looping, marks the plugin unhealthy and surfaces a *Restart* button.
- **Heartbeat** — unresponsive to a ping, kill and restart. A hung plugin must never hang
  the chat.

---

## The plugin contract

The manifest is the entire declared surface of a plugin:

```jsonc
// plugins/voice/plugin.json
{
  "manifest_version": 1,
  "id": "voice",
  "name": "Voice",
  "summary": "Talk to Alexia and hear it answer back.",
  "version": "0.1.0",
  "entry": { "run": "node", "args": ["index.js"] },

  // what it needs from the host, shown to the user in plain words
  "requires": [
    { "cap": "audio.input",  "why": "to hear you speak" },
    { "cap": "fs.own_dir",   "why": "to store the speech model" },
    { "cap": "net.download", "why": "to fetch the model once, from huggingface.co" }
  ],

  // what it offers other plugins, so they depend on this, not on "voice"
  "provides": ["voice.transcribe", "voice.speak"],

  // core renders this; the plugin never draws its own settings screen
  "settings": [
    { "key": "model_size", "type": "choice", "label": "Speech model",
      "options": ["tiny", "base", "small"], "default": "base",
      "hint": "Bigger is more accurate and slower." }
  ],

  // everything this plugin owns, and therefore everything a purge removes
  "storage": { "namespace": "voice", "tables": ["transcripts"], "dir": true }
}
```

### Four message types, and nothing else

- `call` — request/response, both directions. Core calls the plugin; the plugin calls
  host capabilities.
- `event` — fire and forget, for things like `session.message` that many plugins observe.
- `stream` — framed chunks against an id, for token streams and download progress.
- `hello` — the version handshake at spawn. Core and plugin exchange protocol versions
  and either agree, or the plugin is marked incompatible with a message the user can read.

> `hello` is cheap now and impossible to retrofit. Ship it at M0.

*Superseded 2026-08-27 by D50, in mechanism not in intent.* MCP provides all four: `call` is
`tools/call` (and `sampling/createMessage` in the other direction), `event` is
`notifications/*`, `stream` is `notifications/progress` against a `progressToken`, and `hello`
is `initialize` with protocol-version negotiation — already specified, already handshaking,
already refusing politely on mismatch.

---

## The agent loop

*Decided 2026-08-27.* **Alexia keeps working after you hit enter.** You give it a goal; it
plans, acts, observes the result, decides the next step, and repeats until the job is done
or a limit stops it.

This is the decision that makes Alexia genuinely smarter than the tools it was built in
reaction to — and it is the most expensive decision in this document. It pulls directly
against founding goal 3, because one goal can become a dozen model calls. The
reconciliation is in *Paying for autonomy* below, and it is not optional.

### It lives in core

*Confirmed 2026-08-27.* The agent loop is **the biggest and only real exception to "everything
is a plugin"**, and it is worth naming as such rather than pretending otherwise. It is the
product: without it Alexia is a chat window. A plugin cannot own the loop that decides which
plugins to call.

### What it adds to core

- The loop itself: plan → act → observe → repeat, with conversation and step history as state
- **Step limits and a spend ceiling per task**
- **A stop control that always works**, even mid-step
- **Approval gates** before irreversible actions
- **A visible trace.** The user sees what it is doing, step by step. Not a spinner — a
  spinner during a five-minute autonomous run is how you lose someone's trust permanently.

### What it adds to the plugin contract

Plugins stop being only capabilities and become **tools the model can choose**. The
manifest gains a `tools` block:

```jsonc
"tools": [
  {
    "name": "voice.transcribe",
    "description": "Turn a recorded audio file into text. Use when the user refers to a voice note or a recording.",
    "params": {
      "type": "object",
      "properties": { "path": { "type": "string" } },
      "required": ["path"]
    }
  }
]
```

Two consequences worth planning for now rather than discovering later:

- **Tool descriptions are prompt text.** They are written for a model to read, and a vague
  description is a *bug* — it makes the model reach for the wrong tool. The plugin author
  documentation needs a real section on writing them.
- **Tools can vanish mid-task.** The invariant says a folder can be deleted while Alexia is
  running. The loop must handle a tool disappearing between steps by re-planning, not
  crashing. This is exactly where the invariant and the agent loop meet, and it belongs in
  the M0 test suite — the `crasher` plugin should have a sibling that disappears.

### Paying for autonomy

The tension is real and stating it plainly is better than discovering it in a bill:
agentic loops are where token costs come from, and *never pay for what you do not need* is
a founding goal.

In order of how much they actually save:

1. **Tier per step, not per task.** Planning and judgement need a strong model. Listing
   files, extracting a field, formatting a result do not. Routing each step separately is
   where most of the saving lives, and it falls out of the router we already designed.
2. **Show the cost before an expensive run.** *"This looks like about 12 steps, roughly
   $0.04. Continue?"* — once, at the start, not per step.
3. **Hard ceilings on by default** — maximum steps and maximum spend per task, both editable.
4. **Treat free-model agent mode as a real target, not a fallback.** Local models handle
   mechanical steps perfectly well. Whether they can *plan* is an open question worth
   testing at M1 rather than assuming either way.

*Both settled 2026-08-27 — see* Permissions and the safety checker *for the rails, and* Privacy modes *for the cost policy.*

---

## Permissions and the safety checker

*Decided 2026-08-27.* The rails on the agent loop. Modelled on Claude Code's system, with
one deliberate simplification for the target user.

### Two visible settings, and one invisible layer

Claude Code separates three things: **mode** (how much it asks), **scope** (where it may
act), and **rules** (specific always/never exceptions). Alexia keeps all three, but the
user only ever sees the first two.

**What Alexia may do** — one mode, in plain language:

| Mode | Behaviour |
|---|---|
| **Ask me every time** | Every action waits for you. |
| **Ask before anything risky** | Reading and searching run freely; anything that changes, sends or spends waits. **Default.** |
| **Watch and warn me** | Actions run, the checker reviews each one, and only flagged ones stop. |
| **Full trust** | No prompts. Marked *not recommended*, and the never-touch list still applies. |

**Where Alexia may work** — folders chosen in an ordinary folder browser. *Everywhere* is
available and warns when picked.

**Rules stay invisible.** They come from two places the user never edits:

- **Plugin manifests.** `requires` already declares what a plugin needs, with a plain-language
  `why`, written by the author and shown at install time.
- **A fixed never-touch list Alexia ships** — credential stores, system directories, its own
  config. Not editable, and **not overridden by any mode, Full trust included** (D63 — this
  line used to carve Full trust out and contradicted the mode table four lines above it).

> This is the one advantage Alexia has over Claude Code here. Claude Code needs a visible
> rules dimension because its users genuinely want `Bash(npm run test:*)` allowed. Your
> users never will — and the manifest already carries the same information, authored by
> someone competent to write it.

### The checker

A second model reviews an action before it runs. Three possible checkers, in preference order:

| Checker | When it is used |
|---|---|
| **A local model** | Default. Free, private, works offline, no per-action cost. |
| **Claude Code** | When the user has connected it and it is not the model doing the work. |
| **A cloud model** | Available, behind a prominent warning. |

**The warning on cloud checkers is right, and it should be blunt.** A weak or free model in
the checker seat is worse than no checker: it sees whatever data the action touches, which
is a security problem when that data is personal, and it will confidently approve something
destructive.

> **The same objection applies to a small local model, and it has to be answered rather
> than ignored** — because in Local mode a small local model *is* the checker.
>
> The answer is in **what you ask it**. A small model cannot reliably answer *"is this a
> good idea?"* But it can answer *"does this command delete files that existed before this
> task started — yes or no?"* Narrow closed questions are what small classifiers are
> genuinely good at. Open-ended judgement is not.
>
> Which is why: **the fixed rule list catches the catastrophic cases deterministically, and
> the model is never the only thing standing between the user and a disaster.** The checker
> adds coverage on top of the rules; it never replaces them. It is also why *Ask before
> anything risky* is the default mode rather than *Watch and warn me*.

### Declared, not enforced

*Decided 2026-08-27.* A plugin's declared capabilities are **not** enforced by the operating
system. The manifest states what it needs, you review plugins before listing them, and the
checker plus the never-touch list catch bad behaviour at runtime.

This is what almost every plugin ecosystem actually ships — VS Code, Obsidian and browser
extensions all work broadly this way. The limitation has to be stated honestly rather than
implied away:

> **A malicious plugin the user approved can do what it likes.** Nothing at the OS level
> stops it. What stands in the way is review before listing, the checker at runtime, the
> absolute never-touch list, and the fact that every plugin is open source and readable.

Real OS enforcement on Windows means AppContainer or restricted tokens: thinly documented,
fiddly, and precisely the kind of code that is written badly by AI and cannot be debugged
by someone who does not write Rust or Win32 by hand. It stays on the table for the two
capabilities that carry most of the risk — filesystem and shell access — once the contract
is stable and there are real plugins to test against. Not before.

### Two things worth copying from Claude Code

- **Spoken boundaries count as blocks.** Say *"don't delete anything"* and the checker
  treats it as a block until you lift it. Worth knowing the limit: Claude Code re-reads
  these from the conversation each time, so a boundary can be lost when context is trimmed.
  A spoken boundary is a strong default, not a hard guarantee — a rule is.
- **Give up gracefully.** Claude Code stops auto-approving after three blocks in a row or
  twenty in a session, and goes back to asking. Copy that exactly: a checker that keeps
  blocking means it does not understand the task, and quietly retrying is worse than
  admitting it.

---

## Claude Code as a provider

*New requirement, 2026-08-27.* Alexia will integrate a Claude Code subscription by driving
the installed `claude` CLI from PowerShell or cmd with the user's own authentication.

This serves founding goal 3 more directly than anything else in the document: **a
subscription many people already pay for, reused instead of generating a second bill.** And
when Claude Code is not the model doing the work, it is available as the checker.

- **Authentication:** `claude setup-token` mints a long-lived OAuth token for
  non-interactive use — cleaner than automating a browser login. It can only make model
  requests, which is exactly the scope Alexia needs and nothing more.
- **It must be a plugin, not core.** It holds a credential, it depends on an external
  binary, and it is precisely the kind of thing someone might want gone. The thesis applies
  to it like everything else.
- **Handle "not installed" properly.** The plugin detects a missing `claude` binary at
  enable time and says so plainly, rather than failing on first use.
- **Verify before shipping:** whether driving a personal Claude subscription from inside a
  distributed product sits within Anthropic's usage terms and rate limits. Not a blocker,
  and running your own locally-installed CLI with your own credentials is ordinary use —
  but check it before it is in a public release rather than after. See C10.

---

## Access surfaces

*Decided 2026-08-27.* Alexia is reached two ways at launch, sharing one session store:

- **A global hotkey overlay** — the primary local surface. Lives in the tray, one keystroke
  summons it over whatever you are doing, Escape dismisses it. Never in the taskbar.
- **Telegram** — so Alexia is reachable when you are away from the machine.

A full window is not ruled out later, but it is not the primary surface.

### This makes Alexia a background service with thin faces

Both surfaces require something always running: the hotkey must work with no window open,
and Telegram must reach you when nothing is focused. So Alexia is a **tray-resident daemon
with UI surfaces attached**, not an app you launch. Consequences:

- **Autostart on login**, with an obvious way to turn it off.
- **"Is it running?" must be answerable at a glance.** The tray icon is the only answer the
  target user has, so its states — idle, working, needs you, error — matter more than usual.
- **Dismissing the overlay must never cancel a running task**, and a task that finishes
  while the overlay is closed needs a way to get your attention.
- Tauri handles tray and global shortcuts natively, which strengthens the shell
  recommendation in *Stack*.

### Channels

The overlay and Telegram are two instances of one idea: something that delivers a message
into a session and renders what comes back. Making **channel** a first-class concept means
later surfaces — a window, a phone app, Discord, email — are plugins rather than core
changes, and the invariant still holds because a channel plugin is just a folder.

*Decided 2026-08-27: **wait for the third one.*** Two surfaces is not a pattern. Telegram
gets built as an ordinary plugin using normal session APIs, and `channel` becomes a
first-class concept at M4 — if and when a third surface exists and has shown what the
abstraction actually needs to cover.

> An abstraction invented at n=2 is usually wrong in ways you only discover at n=3. The
> cost of waiting is a little duplicated plumbing in the second channel. The cost of
> guessing wrong is a permanent tax on every plugin.

---

## Skills

*New requirement, 2026-08-27.* Alongside plugins, Alexia supports **skills**. The
distinction is worth keeping sharp, because they solve different problems and have wildly
different costs:

| | **Plugin** | **Skill** |
|---|---|---|
| What it adds | Capability — a tool, an integration, a process | Know-how — how to do something well with tools that already exist |
| What it is | Code, a manifest, its own OS process | A folder of instructions, loaded when relevant |
| Runtime cost | ~30–60 MB while running | Nothing until used, then some context |
| Who can author one | Someone who can code | Anyone who can write clearly |

### Why this matters more than it looks

**The barrier to authoring a skill is close to zero.** A plugin needs a developer. A skill
needs someone who knows how to do a thing and can describe it. That is a far larger pool of
people, and it is where an ecosystem actually comes from — most of what makes an assistant
feel capable is knowing *how* to approach a task, not having one more API.

It is also the cheapest possible answer to *"Alexia cannot do that yet."*

### How they load

Each skill carries a short description of when it applies. The model sees only the
descriptions and pulls in the full text when a task matches. A hundred installed skills
cost nothing until one becomes relevant — which is what makes an unbounded library
practical rather than a context problem.

### A plugin can bring its own skills

*Decided 2026-08-27.* A plugin declares skills in its manifest; they install and purge with
it. Whoever wrote a tool usually knows best how to use it well, so the know-how travelling
with the capability is the natural arrangement.

```
plugins/voice/
  plugin.json
  index.js
  skills/
    dictating-well.md     <- arrives and leaves with the plugin
```

Cost to handle: a skill can now arrive by two routes — bundled with a plugin, or installed
standalone from the skills marketplace. Purge has to deal with both, and the marketplace has
to avoid showing a bundled skill as though it were independently installable.

### The invariant holds trivially here

A skill is a folder of text: no process, no tables, no state, nothing to purge. Delete it
and it is gone. If plugins are the hard case for *delete the folder, nothing breaks*, skills
are the case that is true almost by construction.

### Personas

*Decided 2026-08-27.* A default persona ships pre-installed, and the user can switch to
another. Since a persona is instructions rather than code — a system prompt and a tone — it
is closest to **a skill that is always loaded rather than loaded on match**.

**Mechanically, a persona is a node that output passes through.** *Decided 2026-08-27.*
Everything Alexia says *conversationally* — answers, chat, explanations — goes through a
personality node that renders it in the current voice. The node is itself a plugin, so
switching persona is swapping a prompt, and deleting the plugin means Alexia speaks plainly.

**What deliberately does not pass through it:**

| Goes through personality | Bypasses it entirely |
|---|---|
| Answers and explanations | Code |
| Chat and conversation | Actions the agent takes |
| Information delivered to the user | Permission requests |
| | Alerts and warnings |
| | Model or mode switches |
| | Anything else load-bearing |

That exclusion list is the good part of this design. A permission prompt rewritten in a
jaunty voice is a permission prompt someone misreads. **Personality is allowed to change
phrasing and never facts** — and the things where phrasing *is* the fact are kept out of its
reach entirely.

> **The tension worth deciding before building it.** A node that rewrites finished output
> means a *second model call on every conversational reply*. Two consequences: it costs extra
> in cloud mode, in a product whose pitch is not paying for what you do not need; and it
> **breaks streaming** — you cannot show text word by word if it has to be complete before
> the rewrite starts, so replies buffer and then appear at once.
>
> The alternative is injecting the persona into the *original* prompt: free, streams
> normally, but the separation is less clean and the voice can leak into functional output.
>
> A middle path exists: inject the persona into the prompt for conversational replies, and
> generate the excluded categories separately so they never carry a voice in the first place.
> Most of the intent, almost none of the cost. See E10.

**Decided 2026-08-27: rewrite, but only when a non-default persona is active.** Default
Alexia streams normally with no extra call. The node engages only for someone who has chosen a
persona, and accepts the tradeoff knowingly. Nobody pays for a feature they are not using.

The personality pass should run on **a small or local model** —
rephrasing is exactly the narrow, closed task small models handle well, the same reasoning
that puts the safety checker on a local model.

### Learned skills — turning an expensive task into a cheap one

*New requirement, 2026-08-27.* After a task **the model judges was non-trivial** — real
problem-solving happened, and it looks likely to recur — Alexia gives the answer, then offers:
**"want me to remember how to do this?"** A model judgement rather than a step count, because
a five-step task can be clever and a twenty-step one can be tedious and unrepeatable. If yes,
the whole episode
(the request, the steps, what worked) goes to a strong model that distils it into a skill.
Next time the same kind of request arrives, the skill fires instead of the agent rediscovering
the route.

This is the single best answer in the document to founding goal 3. An agent figuring
something out from scratch is expensive; doing it a second time from scratch is *waste*. This
converts one costly exploration into a permanently cheap procedure.

**Hermes already does this**, and it is worth copying deliberately rather than reinventing:
it generates reusable Skill Documents as searchable markdown following the
[agentskills.io](https://agentskills.io) open standard.

**Decided 2026-08-27: adopt [agentskills.io](https://agentskills.io).**

> **The open standard rather than a format of our own.** Skills written for Hermes would
> work in Alexia and vice versa, which means the skills marketplace starts non-empty and
> skill authors are not choosing sides. That is an enormous ecosystem advantage for
> essentially no cost, and it makes the *"more skills, more capability"* claim credible on
> day one rather than after two years of accumulation.

**The hard part, named honestly.** A trajectory is not a skill. It records what happened
*once*, mixing transferable decisions with incidental detail, dead ends and mistakes — and the
next task is never quite the same episode. The distillation has to produce a *procedure*:
what to do, when it applies, and what to check along the way. That is exactly the instinct
behind *"delete all the troubleshooting"*, and it is the whole difficulty.

Two consequences:

- **Distillation needs a strong model, and that is fine.** It runs once, after a task that was
  already expensive, and it pays for itself on every reuse. This is the right place to spend
  money even in a free-first product — and the right moment to ask the user rather than
  assume.
- **A learned skill can be wrong**, having been distilled from a single episode by a model.
  *Decided 2026-08-27:* **attribution at the moment it fires** — "using what I learned last
  time about sorting your downloads", with *edit* and *forget* right there. The user finds out
  when it actually matters, rather than in a settings list nobody opens.

### Two marketplaces, not one

*Decided 2026-08-27.* Skills and plugins get **separate marketplaces**, because they carry
genuinely different risk and should not be reviewed to the same bar:

| | Skills marketplace | Plugin marketplace |
|---|---|---|
| What you are installing | Text the model reads | Code that runs on your machine |
| Worst case | Bad advice | Anything the machine can do |
| Review | Light and fast | Properly, before listing |

Keeping them apart makes the difference visible rather than something a user has to infer
from a badge, and it lets the skills side move fast without dragging the plugin side loose
with it — which is how plugin ecosystems get their first security incident.

The cost, stated plainly: two things to build, two to maintain, and some people will not
immediately know which one they need. The naming has to carry that weight.

---

## The plugin UI problem

A plugin lives in a different process, so it cannot render components into the main
window without dissolving the boundary we paid for.

| Option | What you get | What it costs |
|---|---|---|
| **Declarative UI schema** — plugin describes, core renders | Isolation intact. Visual consistency free. Every plugin matches the theme and looks like it belongs. | Limited expressiveness — forms, toggles, lists, status; not a custom canvas. |
| **Sandboxed iframe** — plugin serves its own HTML | Full expressiveness, isolation intact, communication over postMessage. | Authors must style to match; theme-sync plumbing forever. |
| **Plugin ships JS into the main window** | Total power. | Destroys isolation. One bad plugin can break or spy on all of Alexia. **Rejected.** |

**Decided 2026-08-27: the declarative schema.** The plugin describes what it needs; core
draws it in Alexia's own style.

Nearly all plugin UI is settings, status and progress, which a schema covers completely.
And the consistency it buys is not a consolation prize — when the target user finds
technical things confusing, *every plugin looking and behaving the same way* is a feature.
A plugin cannot style itself wrong because it never styles itself at all.

The escape hatch stays available: if a real plugin later needs a chart, a canvas or a map
and genuinely cannot be expressed as a schema, sandboxed frames get added then, for that
case. Not before, and not by default.

---

## The model router

Core keeps a catalog and picks the cheapest rung that can do the job, escalating only
when it must.

| Tier | What | Cost |
|---|---|---|
| **T0** | Local model (Ollama, if the local-model plugin is enabled) | free |
| **T1** | Free hosted tiers — the zero-cost variants in the catalog | free, rate-limited |
| **T2** | Small paid models — tool use, multi-step work, longer context | cents |
| **T3** | Frontier models — hard reasoning and real code | only when earned |

- **Routing signal, kept boring on purpose.** Classify by request shape: short factual
  reply / formatting / classification goes low; tool-using multi-step work goes middle;
  hard reasoning and code go high. Plus an explicit user override and a per-plugin
  declared minimum tier.
- **The catalog updates itself.** An aggregator such as OpenRouter exposes a models
  endpoint listing everything available with per-token pricing, including free variants.
  Poll daily, diff against the cached copy, surface it as plain news: *three new free
  models are available.* Cache to disk so the app works offline and does not break the
  day the endpoint changes shape.
- **Guardrails in core** — monthly cap, warning threshold, optional hard stop. Attribute
  spend per session, per model **and per plugin**.

> **The detail that decides whether this works:** free tiers throttle. If the router hits
> a rate limit and just fails, then free does not mean free, it means broken — and that
> is the whole product promise gone. Fallback on 429 to the next rung is not a
> nice-to-have, and when it escalates it should say so in one plain line so the user is
> never surprised by a charge.

Good routing is genuinely hard and a learned classifier is a trap this early. Start with
rules plus manual override, then add a one-click *try that again with a smarter model* on
any weak answer — the right escape hatch today, and it quietly collects exactly the
labelled data needed to do something cleverer later.

---

## Privacy modes and the command surface

### Three modes, chosen once, persistent until changed

*Decided 2026-08-27.* At first run Alexia asks which mode to run in. The choice **sticks
until you change it** — it is a standing setting, not a per-message decision.

| Mode | What runs where | Who it is for |
|---|---|---|
| **Local** | Everything on your machine. Text, speech, images — all of it. | Best security, and anyone with a machine strong enough. Alexia **warns plainly about the disadvantages** before you pick it. |
| **Combined** | Cloud does the thinking, planning and executing (free or paid models). Your machine generates the heavy media — images, audio. | The default for most people. You do not need a top-end machine, and you do not pay per image. |
| **Cloud** | Everything through APIs — text, audio, images, browsing. | Weak hardware, or you simply do not want the downloads. |

### Combined splits by capability, not by cost

This is the part worth getting right, because the intuition is backwards from the usual
one. The two capability classes have **opposite** economics:

- **Text reasoning** — hosted models are strong and often free; small local models are
  weak at planning. → *cloud wins.*
- **Media generation** (images, speech, TTS/STT) — a local GPU is free forever after one
  download; cloud charges per image and per second of audio. → *local wins.*

So Combined mode is not a compromise between the other two. It is each job going to the
side that is actually better at it, which is why it is the recommended default.

> **Consequence for the router:** the privacy axis is not one switch. It is a **placement
> policy per capability class** — text, image, speech, browsing — each independently local
> or cloud. `/local` and `/cloud` move all of them at once; the mode picker is the honest
> surface for setting them individually.

### The router has more than one axis

`/local` and `/nsfw` are not two special cases — they are two *axes*. Generalising early
keeps this from becoming a pile of flags:

| Axis | Values | Pinned by |
|---|---|---|
| **Cost** | local free → free hosted → cheap paid → frontier | automatic; `/cheap`, `/best` |
| **Privacy** | on-device only ↔ cloud allowed | `/local`, `/cloud` |
| **Content policy** | standard ↔ uncensored | `/nsfw` |

The router picks the cheapest model satisfying **every currently pinned constraint**.

> **Never silently violate a pin.** If no model satisfies the pins, say so plainly instead
> of quietly falling back. `/local` plus `/nsfw` with no suitable local model installed
> should say *"no local uncensored model is installed — install one, or type `/cloud`"*.
> A privacy pin that silently escalates to a cloud model is a betrayal, not a fallback.

### The command surface

Slash commands in the chat input are the power-user control surface. Confirmed uses so
far: switching model policy (`/local`, `/nsfw`), and forcing or enabling a plugin.

Three constraints that follow from the invariant and the target user:

- **Plugins register their own commands**, declared in the manifest — so deleting the folder
  removes the command too. Same rule as everything else: no core file lists them.
- **Collisions: first installed wins the bare word.** The second plugin's command shows in
  amber; clicking it explains that `/mute` is taken and offers one button to switch to
  `/voice.mute`.
- **The author declares one name; core derives the namespaced form.** `/voice.mute` exists for
  every command, always, whether or not there is a collision — so resolving one never breaks a
  command that already worked, and nobody writes their commands twice.
- **Discoverable.** Typing `/` lists what is available with one-line descriptions. The
  target user will not read documentation to find a command.
- **Every command has a UI equivalent.** Commands are a shortcut for people who like them,
  never the only way to reach something.

*Scope settled 2026-08-27: a shortcut, never the only route. Every command also has a UI equivalent.*

### Switching models does not lose the conversation

*Answering a question raised 2026-08-27.* No — the context is not lost. The conversation
lives in **Alexia's own database**, not inside the model. Models are stateless between calls:
each request re-sends the history to whichever model is currently selected. Switching just
means the next request goes somewhere else.

Three real caveats, in ascending order of importance:

1. **Window sizes differ.** A small local model may hold 8k–32k tokens where a cloud model
   holds 200k+. Switching *down* can mean the history no longer fits and has to be trimmed or
   summarised. Not lost — but possibly compressed, and the user should be told when that
   happens.
2. **Provider-side caching resets.** Any prompt caching you were benefiting from starts over.
   A cost and latency matter, not a correctness one.
3. **Switching from Local to Cloud ships the entire private history in one go.** This is the
   dangerous one.

> **The privacy trap in "detect private info, then offer to switch".**
>
> Detection that happens *after* a reply has come back is too late — the message already went
> to the cloud. Un-sending is not a thing. So the check must run **before the outbound
> request**, on what is about to be sent, never on what came back.
>
> And switching Local → Cloud must **ask explicitly what happens to the history**: carry it
> over, or start a fresh session. Silently uploading a conversation the user held in private
> mode would be the worst betrayal available in this product — worse than never offering the
> feature at all.

### Alexia can suggest a switch herself

*New requirement, 2026-08-27.* Rather than waiting for `/local`, Alexia notices when a switch
would serve the user — private-looking content when a local model is available, or a request
that the current model's content policy will refuse — and offers.

Two rules keep this from becoming annoying or dangerous: it **suggests, never switches
silently**, and the detection runs before sending, per the trap above.

### `/local` and Telegram contradict each other

> If you are in Local mode but talking to Alexia over Telegram, your words already left
> your machine — through Telegram's servers — before any model saw them.

*Resolved 2026-08-27:* **keep both, and be exact about the wording.** Local mode means
*"the model runs on your machine"* and never claims more than that. Telegram keeps working.

Two obligations follow, and they are not optional:

- **The Telegram channel carries a persistent marker** that this conversation crossed
  Telegram's servers. Not a one-time notice buried in setup.
- **Wording discipline, forever.** One tooltip that says "nothing leaves your computer"
  breaks the promise. Every string about Local mode says what actually happens: the model
  runs here. Worth a test that greps UI strings for over-claiming language.

Access surfaces themselves are covered in *Access surfaces* above.

---

## What the user calls it

*Decided 2026-08-27.* **Alexia** is the product name and the default wake word. But on
first run it asks *"what do you want to call me?"*, and whatever the user types becomes the
name they see everywhere and the name Alexia uses for itself.

The rule that keeps this from becoming a nightmare:

> **The display name is data, not code.** One setting — `assistant.display_name`,
> defaulting to `Alexia` — read only by rendered strings and the system prompt. It never
> touches identifiers, file paths, package names, capability names, protocol strings, the
> repo, or anything a developer types. Internally it is `alexia` forever.

Where it does apply: the UI, the system prompt (so the assistant knows what it is called),
and stored memory about the relationship.

*Decided 2026-08-27: display name now, wake word later.* Renaming changes what they see and
what Alexia calls itself, immediately. The wake word stays `Alexia` until wake-word work
happens at all — which only matters if always-listening is ever built, and it is not in the
current plan.

> **One honest cost:** the wake word is the hard part, not the display name. Wake-word
> detection generally uses a model trained for one specific phrase, so a genuinely custom
> wake word means either training per user or licensing a service that does. Renaming the
> *display* name is close to free; renaming the *wake* word is a real project. Treat them
> as two separate features and ship the free one first — see A8.

---

## Voice — the first plugin, and the contract's proof

A plugin contract designed in the abstract always breaks on the first real plugin. Voice
is the right one because it is both the feature that got stuck in the Hermes codebase and
the plugin that exercises every hard mechanism at once.

1. **In the library.** Name, one line of description, size of the download. Nothing
   installed yet.
2. **Enable.** The walkthrough opens: what it does, then its permissions in the author's
   own words — the `why` strings from the manifest, not capability identifiers.
3. **Configure.** Core renders the settings schema and suggests a model size for this
   machine. One question, default already chosen.
4. **Install.** Progress bar driven by `stream` frames, because a 1.5 GB download with no
   feedback is indistinguishable from a hang.
5. **Run.** The process captures the microphone itself, runs Whisper locally, sends only
   text to core. No audio crosses the boundary.
6. **Serve others.** Registers `voice.transcribe` and `voice.speak`.
7. **Disable.** Process stops. Model files and settings stay, so re-enabling is instant.
8. **Delete.** Process stops, model files removed, storage namespace dropped, folder gone.
   Core never noticed it existed.

### Lifecycle and what survives each stage

```
In library --install--> Installed --enable--> Enabled --disable--> Disabled --delete--> Purged
 nothing local          files on disk        process on         no process,        folder, tables,
                                             demand + tables    data kept          files all gone
                                             + files
```

Disable is reversible and cheap, which is why it is the default action in the UI and
delete sits one step further back. **Purge is the transition worth testing hardest** — a
plugin that leaves residue behind has broken the invariant even though nothing visibly
crashed.

---

## Stack

**Process isolation already shrank this question.** Because every plugin is its own
process behind a wire protocol, a plugin's language is *invisible to core*. Core spawns a
process and exchanges JSON with it. So the stack decision binds the **core and shell
only** — not the ecosystem, and not permanently.

**Recommendation on record:** a Rust shell (Tauri) around a TypeScript core, with a
TypeScript plugin SDK first.

- Rust earns its place in the shell: ~10 MB installer instead of Electron's 100+, signed
  automatic updates, OAuth and OS integration handled natively — exactly the phase-two
  things that serve the non-technical user.
- Core in TypeScript keeps iteration fast on a product whose shape is still forming, and
  puts the plugin SDK in the language most people can write. A Python SDK later costs a
  client library, not a rewrite — and that is where ML plugin authors live.
- Rust's real weakness (no stable ABI, so dynamically loaded native plugins must match
  the core's exact compiler and dependency versions) **never comes up**, because this
  architecture never loads a plugin into core's address space.

| Decide later | Decide now, and version it |
|---|---|
| Core language | **The wire protocol** and its handshake |
| UI framework | **The manifest schema** |
| Which SDKs exist | **Capability naming**, e.g. `voice.transcribe` |
| Web app now, Tauri later | **The storage and purge contract** |

> **One constraint to hold from day one** so the Tauri port stays cheap: no Node APIs in
> the UI layer, and every piece of OS access goes through the host capability boundary.
> Hold that and M0–M4 can be an ordinary localhost web app that later gets wrapped,
> rather than rewritten.

Caveat: Tauri renders through the OS's own webview, so rendering differs across Windows,
macOS and Linux. A non-issue for a chat interface; test early if heavy custom canvas work
appears later.

**Confirmed 2026-08-27.** Tauri shell, TypeScript core, TypeScript plugin SDK.

### Keep the Rust shell boring

*This rule exists because of who is writing the code — see below.* Rust is in this project
for four things only: the installer, signed auto-updates, the tray icon, and the global
hotkey. Tauri ships official plugins for all of them, configured largely from the
TypeScript side.

> **If you are about to write Rust business logic, stop.** It belongs in core, behind the
> RPC boundary. A useful tripwire: if hand-written Rust in `src-tauri/` grows past a few
> hundred lines, something has leaked into the wrong layer — move it before it sets.

The reason to be strict about this is not aesthetic. Rust you cannot debug is worse than
no Rust at all, and the whole point of the Tauri recommendation was to get Rust's packaging
benefits *without* taking on Rust as a daily language.

### Platform: Windows first, portable by discipline

*Decided 2026-08-27.* v1 targets Windows, because that is the machine cold-install testing
can actually happen on, and because it is where the non-technical users are. macOS and
Linux should be a porting job, not a rewrite — which costs a little discipline now:

- **Never hardcode a path separator or a `C:\` prefix.** Use the platform's path helpers
  everywhere, including in plugins.
- **All OS access goes through the host capability boundary** — already a rule, and this is
  a second reason for it. Platform differences get solved once, in one place.
- The stdio transport already helps here: it behaves identically on all three platforms,
  which a localhost port would not have.

---

## Who is writing this, and what follows from it

*Recorded 2026-08-27.* The code is written by AI under direction, not typed by hand. That is
a normal way to build now, but it is a real constraint and the plan should be honest about it.

### The good news: this architecture suits it unusually well

Process isolation plus a wire protocol means **every plugin is a self-contained brief with
a testable contract** — a bounded folder, a declared manifest, a fixed set of messages it
may send and receive. That is close to the ideal unit of work to hand to an AI: small,
specified, and verifiable without reading every line. The architecture chosen for
modularity turns out to be the same one that makes AI-written code reviewable.

### What has to be stronger than it would otherwise be

The parts of the plan that catch mistakes matter more here, because mistakes will not be
caught by carefully reading the diff:

- **The CI invariant checks are load-bearing, not ceremony.** Booting with `plugins/` empty,
  the grep that fails the build if core names a plugin, the crasher test, the purge-leaves-
  no-residue test. These are how the thesis stays true when nobody is reading every line.
- **The conformance suite (M3) moves up in importance.** It is the thing that says a plugin
  is correct without a human auditing it.
- **Write the spec before the code.** The manifest schema and the wire protocol should exist
  as written documents first. They are the brief; a vague brief produces vague code.
- **Rails matter more, not less.** An agentic assistant with file permissions, built from
  code that was not line-by-line reviewed, is a compounding risk rather than an additive
  one. The permission modes and the fixed never-touch list are not optional polish.

---

## Roadmap

Ordered so the riskiest assumption gets tested first. The thesis is the plugin
architecture, so **M0 proves the architecture before a single user-facing feature exists.**

### M0 — The skeleton that proves the thesis
- Supervisor: spawn, heartbeat, restart with backoff, kill
- JSON-RPC over stdio with the version handshake
- `plugin.json` schema v1, including capability `requires`/`provides`
- Two throwaway plugins: `hello` that answers, and `crasher` that deliberately dies
- CI: core boots green with `plugins/` empty; the crasher takes down only itself

**Done when** you delete a plugin folder while Alexia is running and nothing else notices.

### M1 — Core minimum
- Sessions and history, settings, secrets in the OS keychain
- API stats with per-plugin attribution
- Model catalog fetch, disk cache, rules-based router with 429 fallback
- Chat shell

**Done when** you hold a real conversation, routed to a free model, with spend showing 0.00.

### M1.5 — The loop and its rails

*Inserted 2026-08-27 (D54). The agent loop is named in this document as the product and as
the one real exception to the plugin thesis — and then appears in no milestone. Absorbed into
M1 it would swallow the biggest chunk in the plan and quietly hollow out M1's* done when.

- The loop: plan → act → observe → repeat, tiering the model per step
- Plugin tools reach the model; the list re-aggregates when it changes
- Permission modes, folder scope, and the fixed never-touch list
- The safety checker, asked closed questions, giving up gracefully
- The visible trace, and a stop control that works mid-step
- Step-trace trimming, summarised for *what worked*
- Ceilings and the one-time spend preview

**Done when** a multi-step task completes on a free model, every step visible, the stop button
works mid-step, and deleting a plugin folder mid-task makes the loop re-plan rather than crash.

### M2 — Voice, the real proof
- The full lifecycle above, purge included
- Declarative UI schema v1, driven by what voice actually needs rather than guesses
- Streaming progress over the wire

**Done when** install → talk → delete leaves no residue on disk and not one line changed
in core.

### M3 — The plugin library
- Registry as a signed JSON index in a GitHub repo, plugins as releases, verified by
  checksum. No server to run yet
- Browse, enable, walkthrough, progress, disable, delete
- Author documentation, a scaffold command, and a conformance test suite a plugin must pass

**Done when** someone who is not you builds a working plugin from the documentation alone.

### M4 — Contract generality
- **Telegram** — a credential, a long-lived connection, and messages arriving from
  *outside* rather than core calling in. Also owns storage (chat to session mappings), so
  it exercises the purge path.
- **Computer control** — the risky, heavily permissioned shape. The reason the permission
  model exists, and the only way to find out whether the rails actually hold.
- Expect the contract to crack here — that is the entire point of doing it before anyone
  else depends on it.

**Done when** all three shapes — voice, Telegram, computer control — work with no
special-casing anywhere in core.

### M5 — The app
- Tauri shell, signed **Windows** installer first; macOS and Linux follow
- Automatic updates, OAuth, tray icon, global hotkey, autostart

**Done when** a non-technical tester installs it cold and reaches a working conversation
without ever seeing a terminal.

> **Run the cold-install test every milestone,** not just at M5. Sit your test person in
> front of it and time them without helping. Ease of setup is a claim you can only verify
> by watching someone fail at it, and the failures get much cheaper to fix at M1 than at M5.

### Pull a rough installer forward to M2

*Added 2026-08-27, once setup became the pitch.* There is a tension in the ordering above
worth fixing rather than living with: **the demo lives at M5, and M5 is last.** If the thing
you are selling is a two-minute first run, you cannot test the claim — or show anyone — until
the very end of the project.

So at M2, build a **crude installer**. Not signed, not pretty, no auto-update: just something
your test person can double-click. It exists to answer one question at every milestone from
then on — *how long did that actually take, and where did they stop?*

M5 remains where the real installer lands: signing, auto-update, OAuth, the polish. What
moves earlier is only the ability to measure the claim the whole product is built on.

---

## Distribution: registry, review, updates

*Decided 2026-08-27.* Three decisions that only make sense together.

### A real backend from the start

Own API and database, rather than a signed JSON index in a git repo.

The cost is real and should be stated: a service to build, host, pay for and keep running,
on 5–15 hours a week that already have three milestones in them.

What it buys — and why it fits the next decision — is **a kill switch.** Because the
registry accepts third-party plugins early, you need to pull a malicious or broken one
*immediately*, not whenever clients next re-fetch a cached file. A git-hosted index cannot
do that. Accepting early is precisely what makes instant revocation worth paying for.

> **Keep it minimal or it becomes the project.** A read API over a database plus an admin
> path for you. No search ranking, no ratings, no download charts, no analytics on day one
> — those are what turn a registry into a product. You need a list with a revoke button.

### Accept third-party submissions early, reviewed by you

Open to others as soon as the registry exists. Two things make this survivable rather than
the thing that quietly eats the project:

1. **The conformance suite must land before the registry opens.** It does the mechanical
   half of review automatically — does the manifest validate, does it boot, does it purge
   cleanly, does it degrade when a dependency is missing. Then your time goes only on the
   half that needs judgement. Without it, review becomes the bottleneck that stops
   everything else.
2. **The version handshake makes early acceptance safe** — see below.

> **Say the quiet part up front.** There is no promise on review time. *"Reviewed when I get
> to it"* is honest and completely fine. A queue that implies a turnaround you cannot meet
> is how solo maintainers burn out, and it is much harder to walk back later than to state
> now.

### Updates: independent, with yours riding along

Third-party plugins update on their own schedule with a protocol version check. The plugins
you maintain ship with the app, so they are always current.

```
plugin says: needs protocol >= 2
core speaks: protocol 3      -> loads normally

plugin says: needs protocol >= 4
core speaks: protocol 3      -> does not load, and says
                                "Voice needs a newer Alexia"
```

**This is what rescues accepting plugins early against a contract that is still moving.**
When it breaks at M4, plugins built against the old version do not crash the app — they
decline to load and explain why. A clean refusal with a reason is a completely different
experience from a broken assistant, and it is the difference between an annoyed
contributor and a lost one.

Cost: two update paths to build and keep in step. They share most of their code; the only
real difference is where the version list comes from.

---

## Working shape

*Recorded 2026-08-27.* **Solo, 5–15 hours a week, no deadline, public repo from the first
commit.** Everything below follows from those four facts.

### What that means for the calendar

Rough, and dependent on nothing going badly wrong — but better than pretending there is no
answer:

| Milestone | Rough effort | Calendar at 5–15 h/week |
|---|---|---|
| **M0** skeleton and supervisor | small, well-defined | 2–4 weeks |
| **M1** core minimum | the biggest single chunk | 4–6 weeks |
| **M2** voice, plus the rough installer | medium, lots of unknowns | 4–6 weeks |
| **M0–M2 together** | the honest MVP | **roughly 3–4 months** |

M3 through M5 are genuinely further out than they look on the page. That is fine — M0–M2 is
where the thesis gets proved, and everything after is optional in a way the first three are
not.

### No deadline means drift is the failure mode

There is no external pressure, which is a real advantage: the plan can stay in the order
that reduces risk fastest rather than the order that demos best. The cost is that nothing
forces a milestone to end.

> The **done when** line on each milestone is the only checkpoint there is. Treat it as the
> actual definition of finished — not a summary of the bullet list above it. A milestone
> that is "basically done" for three weeks has drifted.

Working in 5–15 hour weeks also means **coming back after a gap has to be cheap.** That is
another argument for writing the manifest schema and the wire protocol down as documents
before building against them: a written spec is where you pick the thread back up.

### Public from day one, with the contract marked unstable

The repo is open from the first commit. Open source stops being a promise and becomes
something anyone can check, and an audience can build while the work happens.

Two things this makes urgent rather than eventual:

- **The licence has to be set before the first push.** Apache-2.0 on the SDK and protocol,
  AGPL-3.0 on the app. Changing it later requires every contributor's agreement — trivial
  at one person, impossible at thirty. See *Licence*.
- **A public repo is not a stability promise, and the difference has to be loud.** The
  plugin contract is going to break at M4 — that is what M4 is *for*. Mark it unstable
  prominently in the README and in the plugin docs from the first day they exist. The first
  person who writes a plugin against an unstable contract and gets broken by it is someone
  you would rather have kept.

---

## Risks

1. **Contract churn breaks other people's plugins.** *Now more likely, given the repo is
   public from day one and the registry accepts submissions early.* M3 ships author docs and
   M4 is where the contract actually breaks. Publish them at M3 marked explicitly unstable,
   freeze at M4, and support one version back from then on. The protocol handshake is what
   keeps this from being fatal: an incompatible plugin declines to load with a readable
   message instead of crashing the app. Ship the handshake at M0 or this risk has no floor.
2. **Memory, if lazy spawn slips.** Set a budget at M0 and measure: core under ~150 MB, an
   enabled-but-idle plugin at zero because it is not running. If those slip, the isolation
   decision starts looking like a mistake for reasons that are really an unimplemented
   optimisation.
3. **We are shipping code that runs on other people's machines.** Signed plugins,
   checksums verified on install, capability grants shown in plain words, never
   auto-enable. Decide the review process **before** the first outside submission.
4. **A long leash on top of AI-written code.** *Chosen knowingly 2026-08-27.* Generous
   step and spend ceilings give the best experience and stack two risks: an agent that runs
   a long way unattended, on a codebase nobody read line by line. The mitigations already in
   the plan carry more weight because of it — the fixed never-touch list, the checker, the
   visible trace, and a stop control that always works. Worth revisiting the ceiling once
   there is real data on what tasks actually cost.
5. **Scope, honestly — and it grew today.** Registry, SDK, docs and desktop app were
   already each a real project. A hosted backend and reviewing every third-party submission
   yourself are now on top of that, at 5–15 hours a week, solo. M0–M2 remains the true MVP
   and none of the registry work belongs before it. If time gets short, cut M4 to one extra
   plugin rather than cutting the conformance suite — the suite is the thing that lets other
   people build without you reading every line, and it is load-bearing for the review
   decision.
6. **The licence is a product decision, not paperwork.** Permissive on the SDK and
   protocol maximises plugins written. The app itself is a different question: copyleft
   there is what stops someone repackaging Alexia as the closed subscription product this
   was built in reaction to. Splitting them is normal and legitimate.

---

## Model providers

*Decided 2026-08-27.* **Provider integration lives in core.** Core talks to providers
directly. Claude Code stays a plugin because it wraps an external binary rather than an
HTTP API.

This is a **deliberate second exception to the plugin thesis**, alongside the agent loop,
and it is written down as a choice so it never becomes a drift. Accepted costs:

- Core grows with every provider added.
- Adding a provider means a core release, not a folder.
- Outside contributors cannot add a provider without changing core.

Chosen anyway because something must always work on a fresh install, and a provider layer
in core guarantees that without a bundled-plugin special case.

> **The mitigation that keeps this bounded.** Write core's provider layer against **one
> OpenAI-compatible interface**, not one integration per vendor. Nearly every provider and
> every aggregator already speaks that shape. Then adding a provider is usually a config
> entry — a base URL, a key, a model-list endpoint — rather than new code in core.
>
> Do this and the decision stays cheap. Skip it and core accretes a vendor integration a
> month, which is exactly what the thesis warns about.

### The launch set, working by M2

| Provider | Role |
|---|---|
| **OpenRouter** | The spine. One key, hundreds of models, and a models endpoint carrying prices including the free variants — which is what makes the self-updating catalog possible at all. |
| **Ollama** | Local text models. Required for Local mode to exist, and for the local safety checker. |
| **Direct keys** (OpenAI, Anthropic, Google) | For people who already hold one. Cheap once the OpenAI-compatible interface exists. |
| **Local image and audio generation** | The "your machine makes the media" half of Combined mode. Without it, Combined mode is Cloud mode with extra words. |
| **Claude Code** *(plugin)* | Subscription reuse, and the checker when it is not the worker. *Ships disabled — see D53.* |

> **Measured 2026-08-27 (D51), and it changes the shape of goal 3.** OpenRouter's free tier is
> 20 requests a minute and **50 a day** on an account that has never spent money — 1,000 a day
> once $10 has been spent, ever. One agent task is 10–30 model calls. So Combined mode on a
> zero-spend account is two to five agent tasks a day before it starts returning 429s.
>
> The free-tier adapter therefore moves from *someday* to **M1**, because it is what makes the
> promise true rather than decorative: Groq is 30 rpm and 14,400 a day, Cerebras the same,
> Google AI Studio 1,500 a day — pooled, tens of thousands of free requests a day instead of
> fifty, all OpenAI-compatible. Alongside it: mechanical steps route to T0, and the optional
> one-time $10 gets said out loud rather than discovered at a 429.
>
> **And one honesty obligation falls out of measuring this.** Free tiers are frequently funded
> by the prompts sent to them. The catalog carries `trains_on_your_data` per model, the pool
> shows it, and the mode picker uses it. A product with a *wording discipline, forever* rule
> cannot quietly route a private-feeling conversation to a provider that trains on it.

### Free-tier aggregation: our own adapter

*Decided 2026-08-27.* Support the pattern — a local OpenAI-compatible endpoint pooling many
providers' free tiers — but **write our own** rather than depending on an existing project
such as FreeLLMAPI or OmniRoute. No inherited licence question, no *personal experimentation
only* framing to carry into a distributed product, and full control over behaviour.

Two rules that do not bend:

- **Self-hosted only.** Keys and prompts stay on the machine. A *hosted* free proxy sees
  every prompt, and free proxies are frequently funded by exactly that. Routing to one
  silently would be the same betrayal as violating a Local-mode pin.
- **Respect each provider's terms.** Pooling free tiers is one thing for one person and
  another thing as a shipped product feature. Check per provider before it lands in a
  public release.

---

## Memory

*Decided 2026-08-27.* **Sessions in core, long-term recall as a plugin.**

- **Core** keeps the live conversation and the agent's step trace — bounded and trimmed.
- **A plugin** keeps cross-session recall: what you said last month, your documents,
  embeddings. It owns its own tables and drops them on purge, which also makes it one of
  the three plugin shapes M4 uses to stress the contract.

Deleting the memory plugin makes Alexia forget you across sessions. It does not touch the
conversation you are having right now — which is the line a user would expect, and the
reason history does not live in a plugin.

### Trimming the step trace

*Decided 2026-08-27.* Recent steps stay verbatim; older ones collapse into a running summary;
raw tool output is dropped once what was learned from it has been recorded.

```
steps 1-18   ->  "found 340 files, sorted into 6 groups,
                  moved 312, 28 unclear"
steps 19-22  ->  kept in full

raw file listings: dropped
what we learned from them: kept
```

This matches how the loop actually uses the information — recent detail, older gist — and it
is what keeps a long task from outgrowing the window exactly when it is deepest into the work.

> **And the trace has a second life.** It is the raw material for a learned skill (see
> *Skills*), so the summarisation should preserve *what worked* rather than only *what
> happened*. Trimming for context and distilling for reuse want the same information.

---

## Licence

*Decided 2026-08-27.* **Split**, because the two halves want opposite things.

| What | Licence | Why |
|---|---|---|
| Plugin SDK and protocol spec | **Apache-2.0** | Anyone can write a plugin without legal thought, including commercially. Maximises the number of plugins that exist, which is the whole point of the architecture. |
| Alexia itself (core, shell, app) | **AGPL-3.0** | Fork it, improve it, ship it — but share the source. Nobody repackages Alexia as the closed subscription product it was built in reaction to. |

Two practical notes:

- **Decide it before the first public push.** Changing a licence later needs the agreement
  of every contributor, which is easy at one person and impossible at thirty.
- **Keep the split visible.** A `LICENSE` at the repo root and a separate one in the SDK
  package, plus a line in the README, so a plugin author never has to wonder which applies
  to them.

---

## Storage

*Confirmed 2026-08-27.* **SQLite, one file, with a namespace per plugin.** Core owns the
database; each plugin gets a declared namespace it alone may write to. Purge drops the
namespace, which is what makes the invariant enforceable rather than aspirational.

The user never needs to know where it lives — but it goes in the platform's standard
per-user application data location, never next to the executable, so that an app update or
a reinstall cannot take a person's history with it.

---

## Decision log

Newest first. Every entry is a question from `questions.md` that got answered.

| Date | Decision | Notes |
|---|---|---|
| 2026-08-28 | **D75 — a packaged build is the one artefact nothing else exercises, so it now tests itself** | M2-7. Three bugs sat in the packaged app for a whole milestone, all in one place and all silent: **it had never once reached the credential locker.** `@napi-rs/keyring` opens with `createRequire(__filename)`, which is free in CommonJS and undefined in an ESM bundle, so the import threw and `cross-keychain` read that as *this backend is not supported here*; the PowerShell fallback it quietly chose had its script left out of the package, so behind the silent failure was nothing at all; and `NAPI_RS_NATIVE_LIBRARY_PATH` — set in good faith because it is checked before every other route — is broken upstream in 1.3.0 in a way that takes the route that *does* work out of reach. The repairs were one banner, one copied file and one deleted line; finding them took running the thing. So `pnpm package` now starts what it just built and asks it one question, and this is the general lesson: **the failure mode of a build artefact is not a wrong answer, it is a quiet substitution**, and no amount of unit testing sees it because the tests run in a different module format, resolver and folder layout. The same milestone's D69 said an interface with one implementation in production and another in every test is an interface with an untested implementation. This is that sentence again, one layer down. |
| 2026-08-28 | **D74 — silence is the failure, so progress travels the whole way to the trace** | M2-6. `notifications/progress` now goes plugin → the tool call → an event on the running step → the wire → a bar in the trace row the person is already looking at. M2-1 had taken it as far as the settings screen; this is the route through the agent loop, which is where the waiting actually happens. It cost one optional argument on `Tooling.call` and no new interface — a function of three parameters is assignable to one of four, so every existing fake stayed a `Tooling`. Two rules came out of it. **Asking for progress is what creates the token**: `onprogress` is what puts a `progressToken` on the request, so a plugin that reports has somewhere to send it and one that does not never sends one, and a caller never has to distinguish *no progress* from *no tool*. And **a bar exists only while there is something to say** — one that is always there at zero is not believed when it finally moves, and one left at 97 per cent is worse than none at all. A tool that reports a message and no fraction gets its own words in the row instead, which still beats a row sitting still. |
| 2026-08-28 | **D73 — a folder appearing is not consent: a plugin arrives installed and not enabled** | M2-5 built the lifecycle, and the arrow that turned out to carry the weight is the first one. *Installed* is files on disk. *Enabled* is a person having read what the plugin asked for — in its author's own words, never capability identifiers — and said yes. **Nothing runs on the strength of a folder appearing in the extensions directory**, whoever or whatever put it there. That made enable the moment the namespace comes into existence rather than load: an installed-but-not-enabled plugin owns no tables, spawns no process, is absent from capability routing and from its own settings button, and its bundled skills wait with it — which is what makes the *Installed* box in this document's own lifecycle diagram literally true. **Disable keeps every last thing delete would take**, so changing your mind about a plugin costs a click and not a download; delete sits one press further back and says what it is about to remove before it will do it. The answer is a person's, so it survives a restart as a single row, and purge takes it with the plugin — re-installing later starts at the walkthrough again rather than at a yes somebody gave to a different copy. |
| 2026-08-28 | **D72 — speaking is a second capability on the same plugin, and the two halves bind separately** | M2-4. `voice.speak` does what `capabilities.md` says it does — text in, audio played, nothing out — with Piper making a WAV inside the plugin process and the operating system's own player playing it. No audio library was added and none was wanted. The verification is a round trip: Piper said a sentence and `voice.transcribe` read it back, one word off, with neither call naming a plugin. What the second capability taught: **hearing and speaking are two downloads, so they are two bindings that move independently** — one can be ready while the other is still arriving, and the settings screen has to be able to say so rather than showing a single ready light that is a lie half the time. `speak` declares no `readOnlyHint` for the same reason `listen` does not: making a noise in somebody's room is not read-only in any sense a person cares about, and the answer to *may this play sound* belongs to the person in the room. **Kokoro is deliberately absent**: it is the named quality upgrade and it costs an ONNX runtime and a phonemizer inside this plugin, which is the dependency shape process isolation was meant to make unnecessary and which Piper ships inside its own 22 MB. That upgrade waits for M4-6, where an ONNX runtime is already being paid for. |
| 2026-08-28 | **D71 — the capability binding goes on and off with the file, and voice is where that stops being a paragraph** | M2-3 built the first plugin the contract was designed against. Before its model is downloaded, `voice.transcribe` is declared in the manifest and bound on no tool, so a caller gets `-32050` — the same answer as *not installed*, and the only one it can plan around. The download finishes, `_meta` goes on the tool, and the capability answers. D59 argued for that shape in the abstract; this is it working, verified in that order against the real supervisor. Three decisions of its own. **`listen` declares no `readOnlyHint`**, deliberately: reading a file somebody named is one thing, opening the microphone is a thing a person wants to be asked about, and read-only would be true about the disk and wrong about the room. **`whisper_path` is the first honest use of the `path` widget** — somebody with a build that suits their machine should not be made to download a worse one — and it is also the entire non-Windows story, because a prebuilt CLI is claimed only where one has been run. And **only text crosses the boundary**, which is a property of where the code runs rather than a promise anybody has to keep: core spawns the plugin and reads JSON from a pipe, and there is no method by which it could ask for audio. Purge was measured rather than assumed — 169 MB of downloaded model and binary in, nothing left. |
| 2026-08-28 | **D70 — a skill's index is a tool description, and there is one skill tool rather than one per skill** | M2-2 built the loader. The choice that shaped everything else: the `name` and `description` of every installed skill live in the description of a single `skill` tool, so the ~100 tokens each land where a model actually looks when deciding what to reach for, and the agent loop needed no change whatsoever. Levels 2 and 3 — the body, and a file the body points at — are the same call with a `file` argument, not a second mechanism. Three rules came out of building it. **Reading know-how needs no permission, and that has to be declared**, or the default mode asks the user before the model can open its own instructions; the declaration goes through the same `about()` the gate already asks, and `about` and `call` agree with `list` about whether the tool exists at all. **A folder that fails to load is shown with the reason** — six ways to be broken, including one the spec did not name: two skills answering to one name, where the model cannot ask for either and would silently get whichever was scanned first. And **a bundled skill goes when its plugin does through no code of its own**, because `name` and `description` are re-read from disk and there is no registry row, no database entry and no cached index to fall out of step — the same reason invariant 4 holds, applied to text instead of processes. |
| 2026-08-28 | **D69 — the keychain has been refusing every secret since M1-3** | Not a design decision, a bug worth the same visibility as one. `cross-keychain` allows only alphanumerics, dots, underscores, `@` and hyphens in an account name, and core was building `<plugin>/<key>`. Every read and every write threw — including the provider key somebody pastes at first run, which is the single step that whole screen exists for. It survived this long because every test uses the in-memory secret store and nothing had yet asked the real one: M2-1's settings screen was the first. The separator is now a dot, and the account format is pinned by a test rather than by memory, because the rule belongs to a dependency and will not tell us when it moves. What this says about the project is worth keeping: **an interface with one implementation in production and another in every test is an interface with an untested implementation**, and that gap is worth a check wherever it exists. |
| 2026-08-28 | **D68 — a plugin declares, core draws, and a plugin may report itself but not decide for you** | M2-1 built the ten widgets. The rendering rule was already settled — *a plugin cannot style itself wrong because it never styles itself* — and building it settled two more. **The screen draws with every plugin stopped**, which is why the schema lives in the manifest rather than behind a running process: with lazy spawn, stopped is the ordinary state. And the `alexia/*` layer gained a sixth method, `alexia/settings/set`, because the spec promised a `status` the plugin drives at runtime and gave it no way to do it. That method writes **only the caller's own `status` keys**. The narrowness is the point: a `status` is a plugin's report of itself, everything else on that screen is the user's answer, and a plugin that could quietly rewrite a toggle somebody set would have to be trusted rather than read — which is the wrong way round for this project. |
| 2026-08-28 | **D67 — the house style exists, and it is a document rather than a stylesheet** | M2-D1 done. `docs/design.md` is the thing that settles arguments: type ramp, spacing scale, colour roles named for what they do, shape, states, and the anatomy every one of M2-1's ten widgets is built from. This matters more than a nicer screen because of what this product asks for — paste a key, hand over a folder, let something spend your money. A careful sentence in a careless frame reads as a prototype, and then the honesty is paying for the presentation instead of the other way round. Three decisions worth keeping: **colour means something happened** — amber and red are the only hues, everything else achromatic, so the eye can be trained on two colours rather than nine; **the theme switch is the operating system**, because a toggle is a setting to persist, a control to keep in sync and a third state to explain, and she should look like the desktop she sits in; and **first run is a view of its own** with no header and no composer on it, which turns *first run and the composer are never on screen together* from a rule into a fact about the DOM. Both themes are held at WCAG 4.5:1 by a test that reads the stylesheet, not by eye. |
| 2026-08-28 | **D66 — the overlay works on Windows, and blur-to-hide needs a guard** | M2-S1 run and answered. Tauri 2.11.5 on Windows 11: 200 show/hide cycles, twice, with the always-on-top flag read off the window itself rather than asked of Tauri — the bug the spike exists for is the framework and the OS disagreeing, and a framework cannot be the witness to whether it got what it asked for. Tray icon and global hotkey verified from outside the process. The open Tauri reports do not bite here, so **M5-2 needs no workaround** for them. What it does need is a guard the spike found by failing once: a blur event already in flight can hide the overlay a moment after the `show()` meant to open it. In the harness that was one bad row in 200. In the product it is *click away, change your mind, press the hotkey* — the overlay opening and shutting in the same breath. Blur-to-hide must ignore a blur older than the show it would cancel. |
| 2026-08-28 | **D65 — the crude installer exists now, not at M2-7** | Pulled forward and built as **M1-I1**. `pnpm package` produces `dist-app/Alexia/` — core bundled to one file, `node.exe` copied beside it, the shell, the one native dependency that cannot be bundled, and an `Alexia.cmd` that runs from wherever the folder was unzipped. The reason is a sentence in `docs/cold-install.md` that was never true: *hand them a terminal command*. A machine that has never had Alexia on it has no Node, no pnpm and no repo, so that command measures npm for twenty minutes and Alexia for none. This document already said the double-click *"has to exist long before M5"*; long before turned out to mean now, because D64 moved the first timed test to M2-8 and M2-8 cannot start its clock without it. Data still goes to `%LOCALAPPDATA%\Alexia`, so deleting the folder uninstalls the program and not the conversation. Windows only; the other platforms stay with M2-7. |
| 2026-08-28 | **D64 — cold-install test #1 is waived, and M1 closes on M15-G's evidence** | Not a finding, a sequencing call by the owner: the first cold-install test measures a dev build with no installer, and the work worth doing now is the product. So M1-13 is ticked as *waived*, and the part of it that actually needs a person — sit a tester down, time them, do not help — moves to **M2-8**, which has an installer and can therefore start the clock where `docs/cold-install.md` says it starts. What that costs is stated rather than absorbed: the four-test trend loses its M1 row, and `test/cold-install/results.md` gets a note saying the test did not happen rather than a row saying it did. M1-G is ticked with it, carried by M15-G — a multi-step task on a free local model with every step visible and spend 0.00 is strictly more than *a conversation on a free model*, and the two clauses about the 429 fallback and the pin refusal are held by tests in `router.test.ts`. Both ticks carry a note in their task block so neither is ever read back as a pass. |
| 2026-08-27 | **D63 — the never-touch list has no exceptions, Full trust included** | Building M15-3 found this file disagreeing with itself: the mode table says Full trust keeps the never-touch list, the rules section four lines later said Full trust overrides it, and plan.md's M15-3 sided with the second. Resolved towards the floor. The wire protocol is the half plugin authors write against and it promises "the never-touch list still applies" — a contract that says that must not be a lie. The list is credential stores, system directories and Alexia's own database, so an override makes one mode toggle grant read of every saved password on the machine, and *not recommended* is not informed consent for that. And the plan's own sentence in the same paragraph calls this "what stands between the user and a disaster when the checker is wrong" — a floor with an off switch is not a floor. Full trust still does exactly what it says: it removes prompts, not the floor. Both contradicting sentences are corrected rather than left to drift. |
| 2026-08-27 | **D62 — G5 answered: a small local model can plan, and `tier` could not express it** | Measured, not read: qwen3:8b at Q4 (40k context), driven by the M15-1 loop with no hints, was asked which notes were not done yet. It called `files.list`, read `notes.txt`, read `done.txt`, diffed them and answered correctly — three steps, 113 seconds, and a correct account of its own reasoning. So `hard` work stops skipping this machine and **Local mode is a real agent**. The plan anticipated one row changing from `T1` to `T0`; what it could not see is that the table then read `T0, T0, T0` and was deciding nothing, so it is gone. In its place `PLANNER`, a floor of 7B parameters, because `T0` means *local* and covers a 1B and an 8B equally — the evidence is about size, so the rule is about size. Only local models report a size, so a hosted model is judged by its tier exactly as before. Scope of the claim: this machine, this quantisation. A weaker GPU is a different question and is not answered here. |
| 2026-08-27 | **D61 — the design pass goes before the widgets, not before the features** | D60's finding stands; its placement was wrong. `docs/design.md` earns its keep by being inherited — M2-1's ten widgets conform to it, M15-5's trace is drawn against it — so its deadline is M2-1, and the milestone of features between here and there is worth more than the frame around them. Moved to **M2-D1**, immediately before M2-1. What stayed at M1-D1 is a holding theme, and it is written down as one so nobody mistakes it for the decision: a single dark palette, achromatic on purpose because a hue is a choice and this is a placeholder; the portrait as tab icon, header mark and first-run mark; a focus ring. Two things came out with it that were never taste — the composer was never actually hidden on first run (`form { display: flex }` outranks `[hidden]`, so `form.hidden = true` did nothing since M1-11), and the third mode card wrapped under the fold at 1280×800. Both fixed. The first cold-install test runs on this, noting in its results what was and was not designed at the time. |
| 2026-08-27 | **D60 — the plan had no design task** | M5-5's *"polished"* turns out to name the flow and its timings, not the look, and M2-1's *"every plugin matches the theme"* names a theme nothing in the plan creates. A promise nothing cashes: build the ten widgets first and every plugin inherits an unstyled house style, permanently. Trust is not decoration in a product that asks for a key, a folder and a budget — a careful sentence in a careless frame reads as a prototype, and then the honesty pays for the presentation instead of the other way round. Added as a task; **see D61 for where it ended up in the order.** |
| 2026-08-27 | **D59 — a capability is declared in the manifest and bound on the tool** | Nothing in the spec said which *tool* answers `voice.speak`, and M0-7 could not route without knowing. Two places, deliberately: `provides` in the manifest is the static declaration — what the library shows, what the registry indexes, and what another plugin's `requires` resolves against before either is running — and `_meta: { "alexia/provides": [...] }` on the tool is the runtime binding. The same reason tools are not in the manifest at all: a plugin whose model has not finished downloading cannot answer and must not claim it can. Declared but unbound gets `-32050`, which is the same answer as not installed, and exactly what the caller needs to hear. |
| 2026-08-27 | **D58 — a plugin's working directory is never its own folder** | Windows returns `EPERM` on `rmdir` for any directory that is a running process's working directory. Alexia's headline invariant is *delete the folder while it is running and nothing else notices*; with the cwd set to the plugin folder that deletion fails on the primary platform, for exactly the plugins that are busy. Measured both ways before changing it. Core now spawns with the working directory on a directory it owns and purges, and hands the plugin its folder as `ALEXIA_PLUGIN_DIR`; `entry.run` and any argument naming a file in the folder are made absolute first. A plugin reads its own files from that variable, never from the working directory. |
| 2026-08-27 | **D57 — a plugin speaks MCP `2025-11-25`; `2026-07-28` is accepted, without the Alexia layer** | D55 pinned the newest revision after reading its schema. Building the supervisor against it found what the schema does not say out loud: `2026-07-28` has no server-to-client request channel at all, and four of the five `alexia/*` methods — settings, storage, capability calls, host info — are requests a plugin sends *to core*. On that era a conforming client drops them unanswered; on `2025-11-25` they are answered. Measured both ways before deciding. `2025-11-25` is also what the reference SDK still reports as latest and serves by default over stdio, so it is where the ecosystem is. Core still accepts `2026-07-28` for plain MCP servers, which have no use for `alexia/*`. When MCP retires the older era the five methods move to a channel of Alexia's own, behind `@alexia/sdk`, and the plugin-facing contract does not move. **This supersedes D56 in mechanism:** `input_required` is how the newer era does it, and Alexia is not on the newer era. |
| 2026-08-27 | **D56 — a plugin never sends core a request; it answers with one** *(superseded by D57 — true of `2026-07-28`, which is not the revision Alexia plugins use)* | Building the supervisor against the pinned revision showed the wire spec was ambiguous where it mattered most: on `2026-07-28` there is no server-to-client request channel. A plugin that needs the model, the user or the folder scope answers the `tools/call` it is serving with an `input_required` result, and core re-sends the call with the answers attached — so a handler runs more than once per logical call. SEP-2577 deprecates `sampling/createMessage` and `roots/list` (≥12 months); Alexia keeps both, because "call the provider API directly" assumes an API key a plugin must not have, and routing through core is what makes the user's tier, privacy mode and spend cap apply to a plugin's model use. If MCP removes them they become `alexia/*` methods and the plugin-facing contract does not move. |
| 2026-08-27 | **D55 — MCP `2026-07-28` deleted `initialize`; the pin is two revisions wide** | Reading the pinned schema before writing the spec corrected D50: version, client identity and capabilities now ride in `params._meta` on every request; `server/discover` replaces the handshake; a server may not send an unsolicited notification, so core opens a `subscriptions/listen` stream per plugin. A better fit than the handshake for plugins that are spawned lazily and killed when idle. Answers G3: core accepts the pinned revision and its immediate predecessor, and no more. |
| 2026-08-27 | **D54 — the agent loop gets its own milestone, M1.5** | It was named as the product and given no milestone. Absorbed into M1 it would swallow the biggest chunk and hollow out M1's *done when*. |
| 2026-08-27 | **D53 — Claude Code plugin ships disabled, never auto-enabled** | The user runs `claude setup-token` themselves; Alexia never automates a login. Anthropic's consumer terms bar automated access except via an API key or where otherwise permitted, and `setup-token` is Anthropic's own non-interactive mechanism — genuinely unsettled for a distributed product. Written confirmation sought before any public release enables it. One folder to delete if the answer is no. |
| 2026-08-27 | **D52 — autonomy: build a whole milestone before checking in** | Stops at milestone gates, `[GATE]` tasks, anything irreversible or outward-facing, and genuine blocks. The per-task acceptance criteria and `pnpm check` are what make that safe. |
| 2026-08-27 | **D51 — free means free, by layering three sources** | Measured: OpenRouter free is 50 requests a *day* under $10 lifetime credit. Pool the free tiers (adapter moves to M1), route mechanical steps to T0, say the optional $10 out loud. Catalog gains `trains_on_your_data`, because free tiers are often funded by the prompts. |
| 2026-08-27 | **D50 — the wire protocol is MCP, pinned, plus a five-method `alexia/*` layer** | MCP already is JSON-RPC 2.0 over stdio with a versioned handshake, and it covers tools, progress, cancellation, sampling, elicitation, roots and `tools/list_changed`. Its `readOnlyHint`/`destructiveHint` annotations are the permission model's missing field. The marketplace starts non-empty, exactly as agentskills.io did for skills. |
| 2026-08-27 | **Command collisions: first wins, second offered a namespaced rename** | Core derives `/plugin.command` automatically for every command and it always works, so resolving a collision never breaks a command that already did. Authors declare one name. |
| 2026-08-27 | **Telegram auth: pairing code from the desktop UI** | One-time code allowlists your Telegram user ID. No account system needed. |
| 2026-08-27 | **Learned skills announce themselves when they fire** | With *edit* and *forget* inline. Caught at the moment it matters. |
| 2026-08-27 | **Personality node runs only for non-default personas** | Default Alexia streams normally with no extra call. |
| 2026-08-27 | **First-run flow specified** | Five steps, no account, no tour, no permission questions. Under two minutes in Combined mode. |
| 2026-08-27 | **Personality is a node conversational output passes through** | Itself a plugin. Code, actions, permission requests, alerts and mode switches bypass it. Personality changes phrasing, never facts. Rewrite-vs-inject tradeoff open (E10). |
| 2026-08-27 | **Adopt the agentskills.io skill standard** | Skills portable with Hermes; the marketplace starts non-empty. |
| 2026-08-27 | **Learned-skill offer is a model judgement, not a step count** | A short clever task is worth remembering; a long tedious one often is not. |
| 2026-08-27 | **Plugins can register slash commands via the manifest** | Delete the folder, the command goes. Collision rule still to pick. |
| 2026-08-27 | **Learned skills: distil a long task into a reusable skill** | Alexia offers after ~20 steps. Adopt the agentskills.io standard rather than inventing one, so skills are portable with Hermes. The best answer in the doc to goal 3. |
| 2026-08-27 | **Alexia suggests mode switches herself** | Suggests, never switches silently. Detection must run before sending, not after. |
| 2026-08-27 | **Switching models keeps the conversation** | It lives in Alexia's database. Caveats: window sizes differ, caching resets, and Local to Cloud must ask before carrying history over. |
| 2026-08-27 | **Step trace: recent verbatim, older summarised** | Raw tool output dropped once its lesson is recorded. Doubles as the raw material for a learned skill. |
| 2026-08-27 | **Renaming: display name now, wake word later** | Display name is data. Wake word is a separate, much harder feature. |
| 2026-08-27 | **Plugins can bundle skills** | They install and purge with the plugin. Two arrival routes for skills to handle. |
| 2026-08-27 | **Registry: a real backend from the start** | Chosen for the kill switch, which matters because submissions are accepted early. Keep it a list with a revoke button, not a product. |
| 2026-08-27 | **Third-party plugins accepted early, reviewed by you** | Conformance suite must land before the registry opens. No promise on review turnaround. |
| 2026-08-27 | **Plugin updates independent; yours ship with the app** | The protocol handshake means an incompatible plugin declines to load with a readable message rather than crashing. |
| 2026-08-27 | **Solo, 5-15 h/week, no deadline, public repo from day one** | M0-M2 lands in roughly 3-4 months. Drift is the failure mode; the *done when* lines are the only checkpoints. Licence must be set before the first push. |
| 2026-08-27 | **Plugin UI: declarative schema, core renders** | A plugin cannot style itself wrong because it never styles itself. Sandboxed frames stay available for a genuine future exception. |
| 2026-08-27 | **Two separate marketplaces, skills and plugins** | Different risk, different review bars. Text that cannot execute versus code that runs on your machine. |
| 2026-08-27 | **After voice: Telegram, then computer control** | The two shapes M4 stress-tests the contract against. Memory remains a plugin but is not in the M4 test set. |
| 2026-08-27 | **Skills, alongside plugins** | Know-how rather than capability. No process, no code, authorable by anyone who can write. The cheap half of the ecosystem. |
| 2026-08-27 | **"Whatever you want it to be" means capability, not personality** | Corrected an earlier misreading. The claim is that the gap between cannot and can is one install. |
| 2026-08-27 | **A default persona ships, switchable** | Probably a skill that is always loaded rather than matched. Mechanism open (E7). |
| 2026-08-27 | **Agent limits: long leash** | High ceilings, mostly runs free. Best feel; stacks risk with AI-written code. Logged as risk 4. |
| 2026-08-27 | **Provider integration stays in core** | Reaffirmed after the cost was raised. Second deliberate exception to the thesis. Bounded by writing core against one OpenAI-compatible interface rather than per-vendor code. |
| 2026-08-27 | **Launch providers: OpenRouter, Ollama, direct keys, local media gen** | Plus Claude Code as a plugin. |
| 2026-08-27 | **Own adapter for free-tier aggregation** | Self-hosted only, never a hosted proxy. Provider terms to be checked before a public release. |
| 2026-08-27 | **Sessions in core, long-term recall as a plugin** | Deleting memory forgets you across sessions but never touches the live conversation. Step-trace trimming is an open problem (C12). |
| 2026-08-27 | **The demo is the setup, not the agent** | Under two minutes in Combined mode. Reordered the roadmap: a rough installer moves to M2 so the claim can be measured. |
| 2026-08-27 | **Setup ceiling: five minutes, progress always visible** | Silence kills a first run, not time. Local mode download fits inside this; the two-minute claim belongs to the default mode. |
| 2026-08-27 | **There is a specific real test person** | Cold-install test at every milestone, timed, no helping. |
| 2026-08-27 | **Licence split: Apache-2.0 SDK, AGPL app** | Plugins stay frictionless to write; the app cannot be closed and resold. Must be set before the first public push. |
| 2026-08-27 | **Permissions declared, not OS-enforced** | Manifest + review + checker + never-touch list. OS enforcement stays on the table for filesystem and shell only, after the contract stabilises. |
| 2026-08-27 | **Channel stays informal until a third surface exists** | Telegram is an ordinary plugin. Formalise at M4 if warranted. |
| 2026-08-27 | **Confirmed: stdio transport, SQLite per-plugin namespaces, agent loop in core** | The three flagged as settled unless objected. Agent loop in core is the one honest exception to the plugin thesis. |
| 2026-08-27 | **Stack confirmed: Tauri shell + TypeScript core + TypeScript SDK** | Rust confined to installer, updates, tray and hotkey. Hand-written Rust past a few hundred lines means something leaked into the wrong layer. |
| 2026-08-27 | **Windows first, portable by discipline** | No hardcoded separators, all OS access behind the capability boundary. macOS and Linux become a port, not a rewrite. |
| 2026-08-27 | **Code is AI-written under direction** | Suits the architecture well (plugins are self-contained briefs), but makes CI invariant checks, the conformance suite and written specs load-bearing rather than optional. |
| 2026-08-27 | **Claude Code integrated as a provider and as the checker** | Drive the `claude` CLI with the user's own subscription. Must be a plugin. Usage-terms check outstanding (C10). |
| 2026-08-27 | **Permissions: mode + folders visible, rules invisible** | Rules come from plugin manifests plus a fixed never-touch list. Four plain-language modes; *Ask before anything risky* is the default. |
| 2026-08-27 | **A safety checker, local model by default** | Cloud checkers allowed with a blunt warning. Fixed rules catch catastrophic cases deterministically so the model is never the last line of defence. |
| 2026-08-27 | **Local / Combined / Cloud, persistent until changed** | Agent mode must work with no paid key at all. Combined splits by capability class — cloud thinks, local machine generates media — because the two have opposite economics. |
| 2026-08-27 | **Local mode and Telegram coexist, with exact wording** | Local mode claims only that the model runs locally. Telegram channel carries a persistent marker. Wording discipline is a permanent obligation. |
| 2026-08-27 | **Agentic — Alexia keeps working until the job is done** | The biggest and most expensive decision here. Plugins become tools the model chooses; core gains a loop, rails and a visible trace. Pulls hard against founding goal 3, reconciled by tiering per step. |
| 2026-08-27 | **Global hotkey overlay is the primary local surface** | Tray-resident daemon with thin UI faces, not an app you launch. Autostart, tray states and a never-cancels-the-task dismiss all follow. |
| 2026-08-27 | **Alexia is the name and default wake word; users can rename it** | First run asks what to call it. Display name is data (`assistant.display_name`), never code. Wake-word renaming is a separate, much harder feature (A8). |
| 2026-08-27 | **Telegram wanted as an access channel** | Makes the chat surface plural, which points at core owning sessions and channels delivering into them. Design open (A6, A7). |
| 2026-08-27 | **A command surface in the chat input** | `/local`, `/nsfw`, and forcing/enabling a plugin. Plugins should register their own commands via the manifest so the invariant holds. Scope open (C6). |
| 2026-08-27 | **Privacy is a first-run choice, switchable at runtime** | Not a fixed promise. Both modes can be on; commands pin the axis. Generalised the router into cost / privacy / content-policy axes. |
| 2026-08-27 | **Full process isolation from day one** | Chosen over in-process and over hybrid. Every plugin is its own OS process. |
| 2026-08-27 | **Voice (STT + TTS) is the first plugin** | Used to design the plugin contract against, because it exercises long install, streaming, permissions, heavy local data and clean teardown at once. |
| 2026-08-27 | **Stack deliberately left open** | Recommendation on record (Tauri shell + TS core + TS SDK); to be confirmed. |

---

## Still open

All 49 questions in [`questions.md`](./questions.md) were answered on 2026-08-27, and every
decision is recorded above. Planning the build then raised six more — **G1–G6** in
`questions.md` — none of which blocks starting, and each of which is attached to the task that
will answer it.

The **to do, not decide** list is now attached to tasks in [`plan.md`](./plan.md) rather than
floating: licence files before the first public push (P0-1), the agentskills.io spec (P0-5,
read), Anthropic's usage terms (M4-7, researched — written confirmation outstanding), provider
terms before free-tier pooling ships (M1-6), and the manifest schema and wire protocol as
documents before building against them (P0-3, P0-4).

New questions will keep appearing as building starts. They go in `questions.md`, get answered,
and land here — same loop as today.
