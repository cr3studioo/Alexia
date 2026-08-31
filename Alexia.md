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

**Mechanically, a persona is a standing instruction.** *Decided 2026-08-27 as a rewrite
node; reversed 2026-08-29 (D103) on evidence from the first real personality somebody wrote.*
Core reads the chosen personality **once per task** and appends it to the system prompt, in
front of every decision the loop then makes. The store is itself a plugin, so switching
persona is swapping a paragraph, and deleting the plugin means Alexia speaks plainly.

> **What the first build did, and why it could not work.** The node rewrote the *finished*
> answer: conversational output went through a second model call whose instruction was
> *change the wording, never the content*, and everything load-bearing — code, actions,
> permission requests, alerts, mode switches — bypassed it entirely. That exclusion list was
> the good part of the design and it survives, for the reason it was written: a permission
> prompt in a jaunty voice is a permission prompt somebody misreads.
>
> What it could not survive was a real personality. The first one written by hand was a page
> of chief-of-staff instructions — *raise the dates he set himself*, *ask before anything
> with external consequence*, *say so when he opens something new while something else is
> stalled* — and a rewrite pass sees one completed paragraph, long after every decision those
> lines are about has been made. **Every behavioural line in it was inert by construction**,
> and the pass's own clamp made *return it unchanged* the correct answer, which is what the
> model did. The feature looked broken and was in fact working exactly as specified.

**The three things the reversal buys, and the one it costs.** Behaviour rules work, because
they are in front of the model when it picks a tool. Streaming comes back, because there is
nothing to wait for. The second model call per answer is gone, so a persona is free rather
than the most expensive setting in the product. The cost is that the separation is less
clean: the voice can leak into functional output, which the exclusion list used to make
structurally impossible. **That was the right trade to lose.** The excluded categories are
written by core and never by a model, so a personality cannot reach them anyway; and a
permission question core wrote is the same sentence whatever the system prompt says.

**Nobody has to write a system prompt.** The paste box takes rough notes — *blunt, chief of
staff, calls me Vacen, no emojis, chases the dates I set myself* — and **Adapt** turns them
into the document with one model call, on a rung that can write. Saved by name, as many as
you like, switched from a list. A personality is instructions, so it is still closest to **a
skill that is always loaded rather than loaded on match**; what changed is only which end of
the pipe it is loaded into.

**The one thing an adapted personality may never say** is a rule that turns the gate off —
skip asking, hide what you did, ignore a limit. The adapter is told so. It is a prompt rather
than an enforcement, and that is enough here only because the gate is code: `rule()` runs on
every call whatever the system prompt believes.

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
- **The user's own answer to the money question, on the Models screen** *(D112)*. A
  three-stop slider — **free only · free then paid · paid only** — and under it a shortlist,
  dragged into the order things should be tried in. The middle stop is what the router always
  did and is still the default; the shortlist is empty by default and everything left off it
  still answers behind whatever is on it. Both are pins, so the ★ on that screen moves with
  them: it is the router's own answer rather than a second opinion kept beside it. The slider
  is a **filter, not a preference** — *free only* that reaches for a paid model when the free
  rungs are gone is the setting not existing, which was the complaint. It applies to the cloud
  pool only, because a model on this machine has no price line to sit either side of.

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

### M6 — The control surface

*Added 2026-08-29 (D81).* Skills, learned skills, tools, a trace with a memory, and a panel
each for voice, memory and commitments — the screen that answers *what has this been doing,
what did I say yes to, what does it know.*

- Core contributes only the tabs whose data core owns; **every other tab is declared by the
  plugin that owns it**
- `table` is the eleventh widget (D83) and `graph` the twelfth (D115); every state-changing
  route is guarded or declared safe (D82); a skill a model wrote waits for a yes (D84); a
  plugin declares its tab in its manifest, at `alexia_protocol` 3 (D86)

**Done when** deleting a plugin with the dashboard open takes its tab with it, and no file in
core or the shell contains that plugin's name.

> **Why it is a milestone and not a screen.** A dashboard is where an architecture like this
> usually breaks, because it is the one surface that has to know about everything at once —
> which makes special-casing feel reasonable there and nowhere else. The previous Alexia's
> dashboard listed nine tabs by hand and grew a 480-line panel for one text-to-speech vendor
> inside its own source tree. That is this document's founding complaint arriving by the back
> door: not a feature you cannot remove, but a feature core cannot stop naming.

### M7 — What version 1 knew

*Added 2026-08-29 (D93).* The first Alexia read end to end — not its screen this time, which
M6 already took, but the six things underneath it this repo has no answer to yet. Ordered by
what to build first, not by size.

- **Redaction** — credentials and location stripped before a payload reaches a third-party
  model, in code and before dispatch, with everything behavioural allowed on purpose. This one
  is a **hole**, not a missing feature: free endpoints are the default (D51) and nothing
  guards what leaves.
- **One id** on the spend row, so a cost is traceable to the run that spent it rather than to
  the sitting it happened in
- **Memory that captures without being asked** — greedy capture, slow consolidation, linked
  notes, and a forget that clears the buffer first
- **A voice cloned from fifteen seconds**, which Piper cannot do — and therefore the real user
  D89's `file` refusal was waiting for
- **A button in Telegram**, because there is nowhere to ask a permission question from a phone
  and the plugin says so in its own source
- **Three execution tiers**, where the cheapest has no model in the path and the import graph
  is what guarantees it

**Done when** a free-model request is provably stripped, a cost is traceable to its run, and
Alexia remembers something nobody told it to — then forgets it and it stays forgotten.

> **Read it for the reasons, not the code.** Version 1 is a Python app on the gateway this
> project exists to replace; nothing is vendored and nothing becomes a submodule. What it has
> that a fresh design does not is a record of what failed — a model that marked twenty-four
> real memories as duplicates and silently wrote nothing, a forget undone twelve minutes later
> by a buffer nobody cleared. Those are worth more than the source.

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

### Updates: every plugin on its own schedule, and the app on its own

*Rewritten 2026-08-31 (D118, D119). What it said before is kept below, because the reason it
changed is the useful part.*

**It used to say:** third-party plugins update on their own schedule with a protocol version
check, and the plugins you maintain ship with the app, so they are always current. Two update
paths sharing most of their code, and the only real difference is where the version list comes
from.

**The second half of that was wrong**, and it was wrong in a way that only shows up once the
installer exists. *Ships with the app* means every capability is bytes in a download that
somebody has to accept before they have any idea whether they want it; it means a fix to one
plugin waits for an Alexia release; and it means the plugins we wrote are privileged over
everybody else's by the mechanism rather than by merit — which is the founding complaint of
this project, arriving by the back door. Eight plugins did ship inside the installer for one
milestone. They cost 8.8 MB, sat in `resources\plugins\`, and were reachable only by pasting
a path out of `%LOCALAPPDATA%`.

**So: nothing ships inside the installer.** Alexia arrives able to hold a conversation, and
every capability is a download — ours on exactly the same footing as anybody else's, through
exactly the same shelf. There is one update path now instead of two, and it is the one that
was already built.

**The shelf is GitHub Releases.** A plugin version is a release: the `.tgz` is an asset on it,
and the entry is a fenced block in the notes. Publishing is `gh release create`, so *a
developer cuts a release and users see the plugin* is one step rather than a step and a
deploy. The registry described above — own API, own database, a kill switch — was the right
answer to a question that was never asked, because the account and the card it needed were a
gate that never got passed and the library screen drew *nothing new* for two milestones. The
client still speaks that layout and `scripts/publish.mjs --pages` still emits it, for the one
thing GitHub cannot do: **revocation reaches somebody who already installed it.** Deleting a
release stops every future install and tells nobody.

**Compatibility is now two questions, because it has to be.**

```
plugin says: needs protocol >= 2
core speaks: protocol 3      -> loads normally

plugin says: needs protocol >= 4
core speaks: protocol 3      -> does not load, and says
                                "Voice needs a newer Alexia"

plugin says: min_app 0.2.0
this build:  0.1.9           -> not on the shelf, not offered as an
                                update, and refused if asked anyway
```

`alexia_protocol` is the shape of the contract; `min_app` is the build. A capability that
arrived in 0.2.0 is not a new revision, so a plugin needing it handshakes perfectly on 0.1.9
and does nothing useful — which is a thing that could not happen while everything shipped in
one installer, and is the first thing that happens once plugins move. The screen says *two
plugins and one plugin update need a newer Alexia* rather than listing names nobody can act
on, because the number is the part that is actionable.

**And the app updates itself, in one press.** A newer release is offered at startup — once, in
a strip along the bottom, never a dialog over a conversation — and *Update now* downloads the
installer, checks a signature over it, runs it silently and restarts. Nobody opens a browser,
nobody finds a `setup.exe`, nobody clicks through an installer. That is not a nicety: **the
shelf is only as good as the newest Alexia people are actually running**, and a plugin that
declares `min_app` is invisible to everybody who did not get round to updating. An app that
updates itself is what makes a compatibility floor a thing an author can rely on.

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
| 2026-08-31 | **D119 — Alexia updates itself, in one press, or the compatibility floor is a fiction** | The other half of D118 and not a nicety beside it: a shelf is only as good as the newest Alexia people are actually running, and a plugin that declares `min_app` is invisible to everybody who never got round to updating. **`tauri-plugin-updater` was already a dependency and had never worked** — `pubkey` was the empty string, the endpoint pointed at a domain nobody owns, and `active`/`dialog` in the config are **Tauri v1 keys that v2 silently ignores**, so nothing was ever checked and nothing would have installed if it had been. What was missing was a keypair, a `latest.json`, and one call. All three exist now: the check runs once at startup, the offer is a strip along the bottom rather than a dialog over a conversation, and *Update now* downloads, verifies a minisign signature over the installer, runs NSIS with `/S /R` and restarts. **There is no success branch to write** — the plugin exits the process the moment the installer is launched, because a running Alexia holds the files being replaced — so the only UI is the failure one, with a manual link behind it. **The order in the release workflow is the argued part.** Authenticode rewrites the installer, so a minisign signature taken at build time describes bytes that no longer exist and every update would be refused on every machine with an error nobody can act on. Build → SignPath → `tauri signer sign` → `latest.json`, and it is the only order that works. And the app's release is the one marked latest, which is why `publish.mjs` cuts every plugin release with `--latest=false`: the updater reads `releases/latest/download/latest.json`, and a plugin release claiming to be latest points every install at a release with no installer on it. |
| 2026-08-31 | **D118 — nothing ships inside the installer, and the shelf is GitHub Releases** | Reverses *the plugins you maintain ship with the app, so they are always current* — the one line of the distribution decision that only shows up as wrong once an installer exists. Shipping them means every capability is bytes somebody accepts before knowing whether they want it, a fix waits for an Alexia release, and **our plugins are privileged over everybody else's by the mechanism rather than by merit**, which is this document's founding complaint arriving by the back door. Eight of them did ship for one milestone: 8.8 MB in `resources\plugins\`, reachable only by pasting a path out of `%LOCALAPPDATA%`. `hello` stayed one milestone longer as the offline proof that installing works, and it is gone too — that was an argument about the developers rather than about the user. **What replaced it is a step of first run**: read the shelf, show what this build can run with each plugin's own `requires` sentences under it, install what was ticked. The tick is the consent D73 is about, and it is the one screen where a person is choosing several at once. **The shelf is GitHub Releases** because *a developer cuts a release and users see the plugin* has to be one step: the `.tgz` is an asset, the entry is a fenced block in the notes, and one API call reads the whole shelf. The registry this document specified — own API, own database, instant revocation — was never deployed, because the account and the card were a gate nobody passed, and the library screen drew *nothing new* for two milestones. Its client is kept, and `--pages` still emits it, for the one thing GitHub cannot do: **a revocation that reaches somebody who already installed it.** Deleting a release stops future installs and tells nobody. **`min_app` is the new field and the reason is structural**: `alexia_protocol` describes the shape of the contract, not the build, so a plugin needing a capability that arrived in 0.2.0 handshakes perfectly on 0.1.9 and does nothing — a failure that could not exist while everything shipped together. One check (`versionVerdict`) in three places, so nothing is offered that cannot install and nothing installs that cannot load, and the screen says *two plugins and one plugin update need a newer Alexia* rather than naming things nobody can act on. |
| 2026-08-31 | **D117 — the picture plugin starts ComfyUI, and a permission grew a sentence** | Reverses the first version of `plugins/media`, whose answer to the commonest situation it was ever in — *ComfyUI is not running* — was **correct and useless**: *start it and try again, it is a separate program, and Alexia does not start it for you*. An assistant that can see what is wrong, knows how to fix it, and hands the chore back is the first complaint in this document wearing a different hat. So it starts it: `launch.js` finds the install (the `path` setting first, then a budgeted two-deep walk of the obvious folders), works out which Python that install was made with, and spawns `main.py`. **The permission widened rather than multiplied.** `proc.spawn` was written as *a child process it ships*, because every plugin that had one had downloaded it; this is the first that starts a program already on the machine, and *spawn what I shipped* and *spawn what is already here* are the same power told apart by where a file came from. The `why` is what stays honest, and naming the program is now the bar, exactly as naming the host is the bar for `net.download`. **It is detached, and that is the argued part.** This plugin is lazily spawned and stopped after five idle minutes; ComfyUI takes far longer than that to come up, so tying one to the other means paying the start again after every pause. It outlives the plugin, its pid is written down, and **Alexia never kills a ComfyUI it did not start** — a running server plus a pid we recorded is the only thing `stop_comfyui` will end. The wait is ninety seconds, **deliberately shorter than a slow start**, because core allows a tool call two minutes and a wait that outlives the call says nothing to anybody: past it the answer is *still loading, ask again in a minute*, which is true, and the next call finds it up. That bound is not theoretical — the install this was built against took **six minutes**, all of it custom nodes and a registry fetch, and a plugin that had waited for it would have died at two. Two findings on the way, both from actually making a picture rather than from reading the code. The venv beside the install is the only Python with PyTorch in it, and using the one on `PATH` gets *no module named torch* on a machine where ComfyUI works perfectly. And `VAEDecodeTiled` — **the default path, the one the fp16 black-image fix turns on** — has gained three required inputs since this graph was written, so ComfyUI refused every graph with a 400 and **the plugin had never made an image at all**. It stayed invisible because the refusal's body was thrown away: ComfyUI names the node, the input and the reason in it, and the client printed *400 Bad Request*. Both fixed, both tested, and the body is now read. |
| 2026-08-31 | **D116 — the theme switch is a control after all, and the hook left for it was already half a theme** | Reverses D67's *there is no theme toggle, deliberately*. That reasoning was about the usual case — a tray-resident daemon should look like the desktop it is sitting in — and it is still the default and still the first card; what it was not is an answer for somebody whose desktop is dark at every hour and who wants champagne anyway. The three costs D67 priced turned out to be one kv entry on an endpoint that already existed, one screen that already had the questions on it, and a third state that needs no explaining because it is the first card and it is called *System*. **Three and not two**: *follow the desktop* has to stay sayable after a theme has been forced once, or the switch is one-way and the way back is remembering which way the desktop was pointing. `system` is the **absence** of `[data-theme]`, because that is what the sheet already meant by it. Two things came out of building it that were never taste. **The hook was half a theme**: `[data-theme='dark']` carried the fifteen colours and not `--paint`, the washes or `color-scheme`, so forcing dark on a light desktop got the dark palette with the light theme's brushwork opacity and a white scrollbar down the side — invisible in a review of either block, visible only in the difference between them, and now held by `theme.test.ts`. **And the preference had to beat the network**: core answers in milliseconds and the page still paints first, so a theme read from `/api/state` is a flash of the other one on every launch; the store stays the truth and a script in the page head reads a `localStorage` mirror early enough to matter. The cards are the two paintings themselves rather than swatches — the one place in the product the painting is not a mask, because here the colour is what is being chosen and a preview that took the current theme would show it to you three times. Verified by driving headless Edge over all six combinations of three choices and both desktops. |
| 2026-08-31 | **D115 — the twelfth widget, and the map somebody finally had a use for** | M6-11, and G8 answered on the third asking. `graph` was refused at M6-3 on this schema's own bar — *one user is not enough* — and refused again at M6-7 on a better argument: the memory store held flat sentences with a category, so the edges would have had to be **inferred**, and a picture of inferred similarity looks meaningful and is not, which is a worse failure than no picture because nobody can tell. M7-3 made those links **authored**, and G8 named the condition for reopening it: *when somebody wants to look at the shape of their own memory*. Somebody did. **It still has one user and it was granted anyway, on what the alternatives cost.** M6-7 wrote down three ways to draw a map: a hand-written force layout, a widget, a sandboxed iframe. The first puts a canvas built for one plugin inside core's own shell, which is core naming a plugin — the founding complaint arriving by the back door, and exactly the predecessor's 480-line vendor panel. The third hands a plugin the pixels, and the palette, the labels, the focus ring and the contrast go with them. **Only the widget leaves the shell naming nobody**, so what shipped is the first option drawn inside the third's rules: `packages/ui/src/force.ts`, d3-force's own constants, no dependency, pure arithmetic — and therefore tested in a suite that has no browser. A plugin declares four fields on a node and no colours at all; `mark` draws its ring in `--chosen` **after** the node rather than instead of it, so *what this is* and *where it came from* stay two signals rather than fighting over one pixel. `alexia_protocol` 4, and **the floor stayed at 2**: raising `MIN` is what deprecating a revision looks like, and breaking seven working plugins to keep a number tidy is not a deprecation. **Retuned the same day, from a screenshot of a real one.** Shipping d3's own constants was the mistake — they are for a few dozen dots with nothing written on them — and sixty-three labelled notes drew a hairball whose hub could be dragged across the screen while nothing followed. Four causes, none of them about taste: the layout **recentred itself every tick**, moving whatever was under the cursor and undoing part of every drag; nothing kept two circles apart, because repulsion is a force and overlap is a fact about the picture, so it is a position now; a drag **cooled while it was still being made**, where d3 holds the temperature up for as long as a node is held; and every label was drawn, which is the same as drawing none, so a name claims a rectangle and loses it to whatever is being pointed at. `force.ts` has no DOM in it, so the real graph was laid out headless and the numbers read off rather than eyeballed: 0 overlapping pairs, 0.10 ms a tick, and a hub dragged 985 units now takes its neighbours a median of 562 with it. Two of those are tests. One data bug fell out of it — every edge was in the set twice, because both notes name each other, so every spring pulled twice as hard as the physics was tuned for. |
| 2026-08-31 | **D114 — a voice you can only clone is a voice you have to own, and the predecessor let you borrow one** | Reported from use, by reading the old dashboard's Voice tab beside this one. `plugins/voice` could list the voices on your fish.audio account and clone a new one, and could not see the catalogue everybody else publishes — which is where the voice most people want already is, and which needs no clip, no transcript and nothing on this disk, because a reference id is the whole of what makes one speakable. `fish.js`'s own comment refused it — *browsing a marketplace of voices is a screen of its own* — and the screen turned out to be four widgets: a name to look for, the tags, the languages, and a second `table`. **Filtering is not optional and the default says so**: the catalogue is 41% English on the predecessor's own 300-model sample, so an unfiltered search answers in languages you cannot judge and reads as a bug, which is why the language filter starts on. **Keeping one is a line in this plugin's own store, not a copy**, so Remove on a kept voice *forgets* it and says so — it stays published, and routing that press to the vendor's delete would be asking to delete somebody else's voice. **Preview is spoken, not played back.** The vendor publishes a sample clip per voice and the predecessor put an `<audio>` element on it; a plugin here draws no controls, and the clip's format is whatever its author uploaded, which the operating system's own player may not open. One short sentence through the engine that would actually be answering costs a free call and answers the real question. **And the `action` widget was refreshing nothing beside it**, which is the root the search button found: *New chat* above the conversations and *Clone* above the voices had the same bug, each leaving the list beside it showing the answer to a question nobody was asking any more. One event dispatched at the tables on that screen, so the sentence the press just wrote survives the reload. The conformance host had drifted the same way — it resolved `settings` and not `panel.widgets`, so a plugin reading a box on its own panel would have been handed `undefined` by the bench and a value by the product. |
| 2026-08-30 | **D112 — *recommended* was a word covering a rule, and the rule was not on the screen** | Reported from use. The Models tab marked one row **★ recommended** and offered nowhere to disagree with it. The mark was honest — it is *defined* as what the router would pick, so it cannot drift (D104) — and that is exactly what made it unmoveable: the rule underneath is *cheapest that clears every pin*, while **the word means free to one person, fast to the next, and best to the one paying**. Three different expectations of one setting nobody could see. So the money question is now said out loud, as a three-stop slider above the table: **free only · free then paid · paid only**, written as a `spend` pin and filtered in `route()`. The middle is what Automatic always did and stays the default — the two ends are the two things people wanted to be able to *say*, not a new behaviour. **It is a wall rather than a preference**: *free only* that quietly reaches for a paid model when every free rung is rate-limited is the setting not existing, which is the whole complaint. When it empties the pool the refusal **names the slider**, because *add a key* said to somebody whose key is the reason there is anything on the screen is D107's mistake repeated. **Only the cloud pool has a price line** — a model on this machine is billed by nobody and throttled by nobody, so the axis is not applied to a local pool at all; *paid only* under `/local` would otherwise refuse with a sentence that reads as a bug. Under the slider, the running order as **a shortlist somebody drags** rather than a catalog with a number typed beside each row: two columns by side, reorderable by drag or by arrow keys, added from one search box, and **empty by default**, so an untouched screen behaves byte-for-byte as it did. **The group is a property of the model, not of the list** — a paid row dragged to the top of its own column still sorts behind every free one unless the slider says otherwise, which is what stops one drag turning the free tier off. **`ladder` is not the twelfth widget.** `ui-schema.md`'s bar is *more than one user* and `file` and `graph` were refused on it, so this is not in the manifest schema and no plugin can declare it. What it answers is a gap only core has: **every widget core can declare for its own tabs is read-only.** A plugin's values are written through `/api/settings` against a manifest, and core has no manifest — so this screen could report what the router decided and had nowhere to decide it. It presses `/api/action` like a row action, so there is no new write path and no new gate, and it is drawn by the one renderer both screens share, so `control.ts` still names no tab and no plugin. The M6-4 test moved to assert exactly that, with core's own list written out by name. |
| 2026-08-30 | **D111 — the commands lived on one screen, so the one place that needed them most had none** | Four things, one cause. `/new` did not exist anywhere at all: the window had a button and a phone had nothing, so **every message anybody ever sent from one landed in the same conversation carrying every message before it** — the context never reset because there was no way to reset it. The commands are core's, so they are answered on the sampling path rather than copied into a plugin: one line beginning with a slash, checked before the tools flag and before `asTask`, so a command is answered *while* a task runs rather than queued behind one — `/new` is wanted most exactly when the conversation you are in has gone wrong. Guarded to a single short line with a command-shaped word, because not every plugin on that path carries something a person typed, and a wrapped prompt beginning with a slash answered *there is no /home* would be a bug nobody finds for weeks. **`/new` is a hook, not a behaviour**: *here* is the window for one caller and its own conversation for another, and neither knows about the other. The plugin end clears its own history, because core rotates the conversation it writes down while the history the model is *shown* belongs to the plugin. `/help` is the other half — a place with no palette still needs to know what there is. And the rail now re-reads the conversations on a timer while the window is visible: `refresh()` fired when a task ended *in this window*, which was every way a conversation could change until a message from a phone became one, so a Telegram chat appeared only after something else redrew the list. |
| 2026-08-30 | **D110 — the screenshot was refused by the antivirus, and two of the plugin's other three PowerShell calls were wrong on the shell Windows actually ships** | M4-2, all three found by running it rather than reading it. `screenshot` came back `ScriptContainedMaliciousContent`: AMSI scans every script before it runs, and the one-line capture-and-save is the shape a decade of PowerShell screen-grabbers were written in. Isolated statement by statement — each half runs, the pair does not — so it is written out as a script a person would write, which is the form worth keeping anyway, and **the block is now a sentence** rather than an error id, because a scanner that decides differently tomorrow blocks this too and the only person who can change that is the one at the machine. `windows` used `ConvertTo-Json -AsArray`, which is PowerShell 7 and this is 5.1, so the whole tool was a `NamedParameterNotFound`. And `key` checked *braces round some letters*, so `{SUPER}` passed the grammar and came back from SendKeys as a bare `ArgumentException` — nothing a model can act on, so it tries the same key again. The check is the real keyword list now, and **the Windows key is a key**: SendKeys has no notation for it at all, so `{WIN}` and `{WIN}r` go to `keybd_event`, which can hold one key across another. |
| 2026-08-30 | **D109 — a task started somewhere else was being written into whichever conversation the window had open** | Found in the database rather than by a test: session 5 held two assistant replies with no question above them, because a Telegram message had started a task and `asTask` passed `session` — **the desktop's own conversation, read per request since D106** — to the loop. So the answer landed in an unrelated chat and the message that started it landed nowhere at all, since the user's turn is appended by whoever received it and nothing had. **One core session per plugin**, looked up through `kv` rather than held, so a conversation the user deleted starts a new one instead of dangling on a cascaded id; the plugin's own history stays in its own namespace and is still what the model is shown, so invariant 5 is untouched and this is the transcript rather than the memory. It is titled with the plugin's name, which makes it a row on the Chats screen (D106) with no new screen and no new table. |
| 2026-08-30 | **D108 — the settings screen was one column with nine plugins in it, and the list Activity kept was a second copy of it** | M8-3. Settings is two tabs — *General*, which is what first run asked plus the know-how installed, and *Plugins*, a grid of cards with a page of its own behind each. **The tabs are between screens, never inside one**: a plugin's widgets are still one column in manifest order, because a plugin with enough settings to need tabs has a design problem a tab control would hide. What that rule never covered is *finding the plugin you meant*, which is a different problem and was the unsolved one — the pane list worked at three plugins and is a scroll at nine. **The switch is the only thing on a card that is not the card**, and the click handler asks what was pressed rather than every control asking not to bubble: one rule, which still holds on the day a card grows a second control. **Only what is installed is shown**, with the registry behind a `details`, because this is where somebody comes to change something they have and a grid opening on forty things they do not is a shop. Pressing one asks *this plugin is not installed, do you want to install it?* on the card, with the author's own `requires` sentences under the question. The install bar **sweeps rather than fills**: one request goes out and comes back with the folder on disk, so there is no percentage, and a bar claiming a number it does not have is the other way to lose somebody that silence loses them. **Installed is still not enabled (D73)** — the card does not flip itself on, and a finished install lands on the plugin's own page, which is the walkthrough. **The half that is a deletion**: Activity's *Library* tab is gone. It was a read-only copy of a list the settings screen owns the write path for, and one list in two places is one of them being out of date; the `library` read stays because the palette indexes it, and what moved is the screen the palette opens. That is M6-2's own rule applied to a tab M6-2 wrote. |
| 2026-08-29 | **D105 — **a worked example is a thing a model copies, and the personality adapter was handing one over** `SHAPE` was a complete chief-of-staff personality, on the theory that a model shown a good one writes a good one. Measured instead, on a free model, asked for a Victorian butler: back came the example's headline, its role sentence and **both of its bullets**, with only *How you talk* replaced — so a personality about a butler opened *You are Vacen's chief of staff*. The name the brief explicitly forbids inventing was reaching the document **from the instructions**, and every personality anybody adapted would have been the same person wearing a different voice. The shape is now a skeleton whose angle brackets say what belongs under each heading and name nobody, and the test asserts exactly that: no line of it outside a heading is anything but a bracket. Re-measured after: the same request produced *Punctilious Valet*, invented from the description, with no trace of the template. **Found by running the feature rather than by reading it** — the first version passed every test it had. |
| 2026-08-29 | **D106 — **core had one conversation, and it was a `const`** M8-2. `serve.ts` read `store.sessions()[0]` once at startup, so every install had a single transcript growing forever with no way to start a fresh one or return to an old one — while `createSession`, `deleteSession`, `history(id)` and a cascade had been in the store since M1, unused. The session became a variable read **per request** rather than held from boot, which is the whole of what makes switching work; the checker takes a getter for the same reason, so a review is charged to the conversation it was spent for. The screen is a `table` — a core tab like Activity, drawn by the same widget code as a plugin's — plus one `action` for *New chat*, which is not about a row. Three rules the tests hold: **the open conversation cannot be deleted** (its messages go by cascade, so every later append would dangle), an empty conversation is **reused rather than stacked**, and a task already running **finishes into the conversation it started in**. Titles are the first thing the user said, read in the same query that lists the conversations — a model-written name is a call on a screen that opens at the speed of a file read, and *the one where I asked about the printer* is already on disk. **The M6-4 assertion moved deliberately**: from *a core tab holds tables and nothing else* to the manifest schema itself, which is the property its own comment named, and which caught an empty column label core would not have accepted from a plugin. |
| 2026-08-29 | **D107 — a spent free tier is not a disconnected provider, and the ledger is a pre-check rather than an authority** | Reported as *no provider is connected and nothing has anything left* on a machine with an OpenRouter key in the keychain — the sentence named the one thing the person had already done. Three wrongs on one path, found by reading the real ledger rather than the report: **`usable()` dropped a spent provider entirely**, and `route()` reads that list as *connected*, so one free tier reaching its daily fifty took that provider's 249 paid models down with it; **`sent()` counted every request against the free tier**, including the paid ones that are billed to credit and spend none of it, which is how a key with money behind it talks itself out of its own pool halfway through a day; and **the refusal merged two walls into one sentence**, so *add a key* was the advice for a wall that had nothing to do with keys. A spent tier now stays in the pool as itself and costs the **free models**, not the key. And when honouring the ledger would leave nothing at all it is not honoured — it is this machine's copy of a number somebody else publishes, deliberately the low one (OpenRouter's fifty a day becomes a thousand on a $10 top-up, and nothing here is told), so asking and possibly collecting a 429 beats refusing on a guess. The pre-check is kept rather than deleted, because 104 free models sit on one provider and discovering a spent tier by 429 would cost 104 round trips. **A fourth was hiding behind the refusal**: OpenRouter prices its own meta-routers at `-1`, meaning *varies*, which reads as minus a million per million tokens and sorts below free — so the moment the pool was unblocked, `openrouter/auto` beat all 104 genuinely free models to every automatic choice on the machine. Same class as D104 and caught the same way, by running it. A row the catalog cannot price is a row it does not carry. |
| 2026-08-29 | **D104 — the free tier is one enormous tie, and the catalog's order was breaking it** | Found by fixing D103 and watching it still fail: the personality reached the model intact and the model ignored it anyway. `cheapest` sorted on tier, then the two prices, and **every free model matches on all three** — `T1`, zero, zero — so the winner among twenty was whichever the provider's JSON listed first. *Automatic* picked a 2.6B-class finance model, and the ★ on the models screen agreed with it, because ★ is *defined* as what Automatic would pick. **The axis was already fetched and already unused**: `weekly` — how much the world put through each model — whose own comment had made the argument a week earlier, *a free model nobody sends anything to is a free model with a reason nobody wrote down*. One line in the comparator, and it is the only quality signal here that comes from outside this machine, so it cannot go stale the way a list of good models written into a file would. **A provider that publishes no figure sorts behind one that does**, the same way `nsfwOk: 'unknown'` does not satisfy an uncensored pin: absent is not zero and not bad, it is unknown, among models that were otherwise going to be ordered by a feed's whim. **Pinning was tried first and is the wrong fix** — `route()` returns a single choice for a named model, so a pinned free model that 429s has nowhere to fall back to, and *429 goes to the next rung* is the older promise. Measured live: the first choice was rate-limited upstream and the answer came from the second, in character. |
| 2026-08-29 | **D103 — a personality is a standing instruction, not a rewrite of the answer** | Reverses the 2026-08-27 decision on evidence the build produced. The first real personality written by hand was behavioural — *raise the dates he set himself*, *ask before anything with external consequence* — and the rewrite node sees one finished paragraph under an instruction that forbids changing content, so **every behavioural line in it was inert by construction** and *return it unchanged* was the model's correct answer. Looked broken; was working as specified. Core now reads `persona.personality` once per task and appends it to the system prompt. **Three wins and one loss, and the loss is the cheap one**: rules work, streaming comes back, the per-answer model call is gone; the voice can now leak into functional output, which the old exclusion list made structurally impossible — except that core writes those categories itself, so a personality never reaches them. **The plugin becomes a library rather than a filter**: rough notes in, one model call on a rung that can write, a named document out, as many as you like and switchable from a list. The adapter is told never to write a rule that skips the gate; that is a prompt and not an enforcement, which is only enough because `rule()` is code. **Two dead fields fell out of writing it**: `modelPreferences` on a `sampling` request and `min_tier` in a manifest are both ignored on that path, so the old node's *cheapest rung* comment and the new one's *a rung that can write* were each untrue the day they were written — M8-1. Whether a call a person pressed a button for may spend like the task it is, rather than inheriting G12's timer ceiling, is **G13**. |
| 2026-08-29 | **D102 — quitting left the core running, and a second launch made two Alexias on one database** | Found on a real desktop, which is the only place it shows. `spawn()` returns a handle and dropping it does not stop the process, so the tray's Quit ended the window and left the daemon holding a port and the SQLite file; the next launch put a second core beside it. **Two halves, and neither replaces the other**: the shell kills the core on `RunEvent::Exit` — orderly, and the path Quit takes — and the core watches its own parent and exits when it goes, which is the only one that survives a crash, an abort or Task Manager. **The tray is untouched**: closing a window still hides it, because Alexia is a daemon and closing its window is putting it away. The check asserts that alongside the kill, so the two cannot be conflated by a later tidy-up. Not an eleventh invariant (D82's reason). |
| 2026-08-29 | **D101 — M7 is reached, and the gate was run rather than asserted** | The three claims that are hard to fake, measured in one pass: a payload carrying an API key, an env assignment and a street address reaches no third-party tier with any of the three in it and reaches a local model whole; two tasks in one sitting have different totals a session number cannot separate, and a 429 fallback names both models against the cost it explains; and a real plugin process writes down something nobody asked it to, links it, then forgets it out of the buffer as well as the notes. **Three findings came out of measuring rather than describing**, none of them the thing being measured — an overclaiming comment caught by the check that exists for it, a credential shape that walked through the egress scan because the keyword sits in the middle of the name, and a store that threw rather than returning nothing on a table written to for the first time. All fixed at the root. All six of M7 shipped; one line of M7-4's acceptance is recorded as not met rather than fudged. |
| 2026-08-29 | **D100 — the cheapest rung has no model in it, and the contract question never arrived** | M7-6. The two rungs below *a model deciding every step*: a whitelisted registry of six steps, `{step_id}` substitution so a decision's answer is what the next deterministic step acts on, and a plan checked whole before anything runs. **The zero-cost guarantee is structural, and stronger here than in the predecessor** — the module imports one file and it spawns PowerShell; `ask` is handed in by the caller, so a script replays with none at all. Version 1 needed its script engine to avoid importing the gateway inside one process; **a plugin cannot reach a model except by asking core, so *not asking* is the whole proof** — and the check is written down anyway, because the day somebody adds the SDK to that file nothing else would notice. Recording cost nothing to build: the action log already existed, so *save that as a plan* is a read of it. **The biggest contract question of the six turned out not to be one**: who stores it is the plugin's own namespace, who approves it is the same gate asked once for the sequence rather than once per click, and what it may touch is only what the registry holds — which holds only what this plugin's annotated tools already do. |
| 2026-08-29 | **D99 — the yes can come from the phone, and it is one flag rather than a new method** | M7-5. Telegram's own line — *you have no tools on this path* — named a real limit: nowhere to ask a permission question from a phone, so rather than a task hanging on a prompt nobody could see, the path carried no tools. Two pieces lift it: **`ask.confirm`**, a core capability that is a question out and the chosen option back, and **`alexia/tools`**, one optional key on a `sampling` request that turns a completion into the whole loop — tool list, gate, trace, ledger, on the terms a task from the window gets. **A flag rather than a new method, and the contract's number does not move**: an Alexia that does not know the key ignores it and answers without tools, which is what it did before, and *a change a plugin can see going wrong* is the bar for a bump. **One gate, two callers**, extracted so a phone meets the same `rule()` the window does — two copies of a permission gate is two rulings waiting to disagree. **The 64-byte cap is a property of the shape**: the action never travels, an opaque token does. **No fallback channel for a question** — ntfy has no buttons, and one sent there would look answered and never be. Voice notes needed nothing inbound and a new `voice.render` outbound, because `voice.speak` is deliberately *nothing out*. |
| 2026-08-29 | **D98 — a voice that is yours, and the engine it costs, said out loud** | M7-4, **G10 answered: one plugin, and no engine setting either.** The contract decided the first half — two plugins would both provide `voice.speak` and the resolver returns whichever loaded first, so which voice speaks would depend on load order with nothing to say so. The second half G10 did not ask: a voice is already chosen in one place, so where it runs is a property of the voice rather than a switch to keep in step with it. **M2-4's refusal of a cloud vendor is priced, not overturned** — Piper speaks unless somebody picked a cloned voice, and picking one is the yes. **`file` refused a second time on a new argument**: the clip cannot be recorded here, because the only recorder this plugin has returns text. **Expression is filtered rather than trusted** — an unrecognised marker is *spoken*, so the vocabulary is quoted and the model's output filtered against it, and an annotator that changed the words has its answer thrown away entirely. With a local voice it is off and says why. **One acceptance line is not met and is written down rather than fudged**: a cloned voice lives on an account, so deleting the plugin does not delete it — Remove on the panel does, and the tool says so as it clones. The live clone call is unverified: there is no key on this machine, and the file says which shapes were run against the real API and which were not. |
| 2026-08-29 | **D97 — Alexia notices things now, and the switch is the binding** | M7-3, and **G9 answered: one plugin, decided by the contract.** Core hands each finished exchange to a new core capability and forgets about it — never awaited, always caught, because a memory that could delay an answer is one people turn off. **Credentials are stripped on the way and location is not**: what may be written down is not what may be sent. A second plugin *cannot read the first's tables*, so *recall* would see half the memory — running the cheap one only survives as a toggle instead. **The consent lives in the runtime binding**: the capability is bound only while capture is on, so with it off core never hands the conversation over at all. One stage where the predecessor had two, because its cheap triage existed to keep an expensive model off the volume and a plugin on its own clock cannot reach one. Two layers of forget rather than three: its permanent raw log is a second copy of everything anybody ever said. All four hard-won details are in — code overrules a model claiming a duplicate, the cascade clears the buffer first, a tombstone is written whether or not anything matched, and a batch that breaks the call is set aside after three tries and never discarded. **G8 has reopened with a real user**: these links are authored, which is the condition D90 named, and nothing was built on it. |
| 2026-08-29 | **D96 — a plugin may work on its own clock, and on it spends nothing but free** | **G12 answered**, and it had to be first: M7-3 said not to build until it was. `resident` (D77) and `sampling` had already answered half. The ceiling is the other half, and it is a **tier rather than a number** — M15-7's spend preview is what makes an expensive run somebody's decision, and a timer waking up has nobody to show it to. **Derived, not declared**: the router reads *attributed to a plugin, belonging to no run* as *free only*, which M7-2's `run_id` made expressible the day before — one rule, in the same place M7-1 put one, rather than a flag at every call site somebody must remember. The checker keeps its paid path because it runs inside a task and carries that task's id. **A real tightening**: until today a resident plugin could spend to the monthly cap with nothing between it and the money. Backlog 7–10 are unblocked and inherit the ceiling. |
| 2026-08-29 | **D95 — a cost belongs to a run, and the trace stopped keeping its own tally** | M7-2. Two columns on `usage` — `run_id`, and `asked` beside the `model` that answered — written by the router, carried by the loop, handed down by the server. A session is not a run: ten tasks in one sitting share a `session_id`, so the ledger could say what today cost and could not say what *that* cost. **The restraint is the lesson**: no second id scheme, just the id there already, put on the rows that were missing it. **The subtraction had to go rather than gain a column** — a run's cost was the allowance before it subtracted from the allowance after, which two overlapping runs would split between them and which could never name the expensive call. The trace now holds the ledger's own rows, so the two cannot disagree. **The checker's spend lands on the run**, since a review is a model call made because of a task, and a total omitting the reviews that made a task safe would be smaller than the truth. The activity table grew a **Cost** column and nothing else changed, which is M6-4 still holding. And a run with no charges says *no model call was recorded against this run*, because `$0.0000` is a different claim and sometimes a wrong one. |
| 2026-08-29 | **D94 — the payload is read before it goes, and the third exclusion has a test** | M7-1, and **G11 answered: egress redaction is core's rule.** `packages/core/src/redact.ts` strips credentials and location from everything bound for anything but `T0`, called from `send()` one line above the only `chat()` in the repo — **one door out of this codebase**, with a test that reads the source to prove it, because a rule enforced at whichever call site somebody remembers is not enforced. `T0` is exempt on a fact rather than a hunch: only `ollama.ts` ever writes that tier. **The interesting half is what is deliberately allowed.** The owner's quote heads the file, and *"the things how i operate, what i do, what i like"* is exclusion 3 — so four behavioural sentences are asserted to arrive **whole**, and a later session tightening this helpfully goes red rather than unnoticed. Version 1's IBAN and card rows did not come across: it carried them for a rule of its own, and a pattern eating any thirteen-digit run is a real cost paid against a payload the quote permits. **No capability, no manifest field, no setting** — a plugin never sees the outbound payload, so an opt-out would first need a way to ask for one, and *a redaction a plugin can decline is a redaction the worst plugin declines*. The legitimate case is priced rather than denied: a plugin whose job is addresses gets them stripped on the way to a hosted model, and its answer is `T0`, where nothing is stripped because nothing leaves. **The ceiling is stated, not hidden** — sixteen patterns, narrow on purpose, and they will miss something. |
| 2026-08-29 | **D93 — version 1 was read end to end, and it knew six things this repo does not** | M7 added. M6 took the previous Alexia's screen; this is what was underneath it, found by comparing its `control/`, `core/` and `adapters/` against what is actually built here rather than against what anybody remembers building. **One of the six is a hole rather than a missing feature**: free endpoints are the default (D51), and nothing strips a credential or a location before a payload reaches one — which version 1 did in code, with three exclusions whose third is *everything behavioural goes, deliberately*, quoted verbatim so a later session cannot tighten it into uselessness. The other five, in build order: **one id** on the spend row, since `usage` carries a session and ten tasks in a sitting share it; **memory that captures without being asked**, the largest, and carrying four failures already paid for elsewhere; **cloning**, the real user D89's `file` refusal was waiting for; **a button in Telegram**, because that plugin's own source says *you have no tools on this path* and means there is nowhere to ask; and **three execution tiers**, whose free bottom rung was guaranteed by the import graph rather than by a comment. **Four more are Backlog rather than tasks** — proactive messaging, a reliability scorecard, bounded self-healing, web-watch — all waiting on **G12: may a plugin run on its own clock, and spend on it**, which `resident` and `sampling` half-answer and the ceiling does not. Nothing is vendored; every path is named to be read for its reasons, and every task stands if the folder is gone. |
| 2026-08-29 | **D92 — the palette searches the panels themselves, and M6 is done** | M6-10. Ctrl+K from anywhere; Enter opens the tab the thing lives on, with its name already typed into that panel's filter. *One search endpoint over each source's existing read path* turned out to be literal — it ranks the rows the tables show, so there is **no second index**, and a skill that has just been forgotten is gone from the palette by the act that removed it. A plugin's panel contributes its **name, not its contents**: reaching inside one is a tool call, and a palette that spawned every plugin on every keystroke would be a search box with a startup cost. Fifteen lines of ranking, no dependency, ties broken by label so the same query gives the same order twice. **It navigates; it does not execute** — what comes back is a tab and a word. **M6-G was then run rather than asserted**: three plugin panels open, a plugin deleted, its tab gone with it, and the word absent from all thirty-nine files in core and the shell — with a purge refused without a confirm, a run outliving the task that made it, and a learned skill waiting for a yes, all on the same run. |
| 2026-08-29 | **D84 built — a skill a model wrote now waits, and the three records stayed three** | M6-9. `Skills` grew a second list — `all` for the screen, `usable` for the model — and **a skill nobody has said yes to is in neither the index nor anything the model can read.** That is the difference between a ladder and a label. Bundled is live because enabling the plugin was the yes; a marketplace install writes a **preauth** before the download, spent by the folder that arrives under that name and nothing else; a learned skill is marked `learned` at creation and waits, because nobody asked for it; a folder that appeared is `unknown`, which is a fact rather than a shrug. **Pending is derived rather than stored** — *not bundled and not yet allowed* — so nothing transient gets a row that outlives it. Two findings from building it: the screen needs **its own reader**, because a review screen that cannot open the thing under review asks you to guess; and **two tables on one screen cannot share a row-action key**, since a press is looked up by key. The two rules under the ladder — the checker is code, never a model, and a revise-and-recheck loop asks the ceiling before it dispatches — are written into `learned.ts`, where a future version of that file is what would break them. |
| 2026-08-29 | **D91 — the panel mechanism held for a plugin that did not exist when it was written** | M6-8. `plugins/commitments` is an append-only record of what you said you would do — statement, day, **whose idea it was**, state, how many times it has been raised — with a read-only panel. It **passed the conformance suite on the first run**, with no change to core, no change to the suite and nothing added to the schema. That is the task's reason for existing: every other panel in M6 attaches to something core already ships and could therefore have been special-cased into working, and this one could not. The check reads the six files where a name would have had to appear and finds it in none. Two decisions came out of writing it: **the panel is read-only**, because a commitment is recorded in the conversation where it was said and a second way in from a table would be a parallel mechanism into a record whose value is that it only grows; and **a date is understood or it is not**, because a ledger that quietly decided which Tuesday you meant would nudge on the wrong day and never say why. |
| 2026-08-29 | **D90 — the graph is refused, and the store is the reason** | M6-7, and G8 closed. The memory panel ships as a table: everything remembered, grouped by what sort of thing it is, the whole sentence under the row, and **Forget** on it. That is why a person opens the screen — *it remembered something wrong* — and it needed a new tool, because `forget` takes *words from the thing to forget*, which is right in a conversation and wrong on a screen. There the person is **pointing at a row**, so `forget_one` takes the row and nothing guesses in between. **Then the graph, and there is nothing to draw.** Backlog item 4 wants *a chart, a canvas or a map that genuinely cannot be a schema*; the real plugin stores flat sentences with a category. The predecessor's graph was over a vault whose links were **authored**, and here they would have to be **inferred** — a graph of inferred similarity is a picture that looks meaningful and is not, which is worse than no picture because nobody can tell. The three answers stay open for a plugin with real edges. **Two widget questions decided on evidence, two refusals, and neither for the reason expected** — `file` because its one user could not do the thing it was wanted for, `graph` because its one user has no graph. That is what deferring to the evidence is for. |
| 2026-08-29 | **D89 — `file` is refused, and the single user is the reason** | M6-6, and G7 closed. The voice panel ships either way and it did: every voice this machine has, *Speak in this* and *Remove* on the rows, and a `path` plus an `action` for bringing your own — the first tab core has never heard the name of. What decided `file` is that **the use case that motivated it does not exist here.** The predecessor's owner asked for *load 15 seconds of a voice and text*; that is cloning, it belongs to the vendor refused at M2-4 for what it costs, and **Piper does not clone from a recording**. What a person can actually do is bring a Piper voice they already downloaded — so they have already been to the file, and `path` is an equal first minute rather than a worse one. D83 deferred this to be decided on evidence, and the evidence came out the other way, which is the deferral working. **The structural finding is kept**: a browser will not tell a page where a file is, so a `path` can never be filled by picking, and *choosing a file* really is inexpressible here. That argument is waiting on a real user; one user with a convenient need is what the bar exists to refuse. **One widget moved rather than being added** — the `voice` `choice` setting is gone, because a dropdown whose options are fixed in a manifest cannot list a voice that arrived afterwards. |
| 2026-08-29 | **D88 — the trace got a memory, and the two consumers stayed two** | M6-5. The live trace is a progress indicator — it exists while the task does and goes with it. The record is the **same event stream read by a second consumer**, keeping what the loop did rather than what the model was shown; those differ by M15-6's design, and trimming the panel because the context was trimmed would be one decision serving two jobs badly. **Five runs, in memory, gone on restart**, with the predecessor's reason kept: restarting to an empty history is the honest behaviour for something that was never meant to be a permanent log, and a person who wants one exports it. Three small things came across and each earns more than its size. **`backtrack`** — a step beginning while the one before it is in error is a retry, and saying so turns a flat list into an agent visibly recovering. **Two model labels** — asked-for and answering differ when the router falls back on a 429, and since the header badge shows one, a trace showing one too would hide the fallback in the only place it is explicable; that needed one new loop event carrying both names, which the router already knew and nothing had asked for. And **export is the run as text in a file**, because *send it to somebody* is what it is for — rendered by the same function as the on-screen detail, so what somebody reads is what they send. |
| 2026-08-29 | **D87 — three panels, one widget, and the one thing that did not fit was the finding** | M6-4. Four core tables — installed skills, the ones Alexia wrote, every tool every enabled plugin offers, what is on this machine — drawn by the same function that draws a plugin's panel, with **not one line of bespoke rendering** between them. That was the test the task existed to run: *if any of them needs a line of its own, `table` was the wrong widget.* **What did not fit was `edit`**, and leaving it out was the honest answer rather than a gap — a textarea is not one of the eleven, and editing a learned skill belongs where M4-5 put it, beside the attribution line at the moment it fires, which is the only moment a person can see what it did. The panel answers the week-later question instead: **what was this learned from**, recorded at distil time because the skill's own text cannot say — a model wrote that text — and shown as *not recorded* where it predates the record, never guessed. Two rules from the previous dashboard came across unchanged and now carry weight: **read-only unless this screen is the only owner** (the plugins screen owns installing and removing; `tooling.ts` reads the plugins; the only write path here is *forget a skill*) and **a broken thing is a row with a reason, not an absence**. The one write path is guarded by the route guard rather than by the permission ruling, because core acting on core's own data has no tool call to rule on. |
| 2026-08-29 | **D83 built — the eleventh widget shipped, and it invented nothing** | M6-3. `table` is in, at `alexia_protocol` 3 with `panel`. The two claims that made granting it cheap both held: **a row action is an `action`** — one lookup, one `rule()`, the same two-step question, with the row it is about carried along and the question beside that row — and **rows arrive over MCP's own `structuredContent`**, because the protocol already has an envelope for structured tool output and a second one would be a dialect. It is the only widget that needs a running plugin, which is the division M6-2 set up rather than a hole in it: the panel draws from the manifest while the process is stopped and asks for its contents when a person opens it, through the same gate as anything else. Three author mistakes get three sentences naming what was expected, never a blank list. And it forced one refactor worth having on its own — **the permission ruling is written once** and used by four callers, the copy made a task earlier having already begun to drift. |
| 2026-08-29 | **D86 — a plugin declares its own tab, and that cost a contract revision** | M6-2. The control surface's tab list is assembled: core contributes the tabs whose data core owns, and every other one is a `panel` in the manifest of a plugin somebody enabled. Nowhere does a person type a list of tabs — which is the point, because a dashboard is the one screen that has to know about everything at once, and the previous Alexia's listed nine by hand with a 480-line panel for a single text-to-speech vendor sitting in its own source tree. `panel` is a manifest field, so **`alexia_protocol` goes to 3**, and `MIN` rises to 2 with it: *one revision back is supported* kept for the first time rather than described, with the first-party plugins migrating by one character. Two things fell out of building it. **`settings` and `panel.widgets` are one namespace** — a widget's value is stored once, so two declarations of one key could disagree about its type; the same key twice is a load error and picking the screen is the author's job. And **the widget renderer became one file** serving both screens, because a second one would be a second set of rules about where a `password` goes, and they would drift on the day one was fixed. **Invariant 1 now reads `packages/ui` as well**, added while it still passed trivially — the only time a rule is free, and what turns M6-G's *no file in core or the shell names the plugin* into a check. |
| 2026-08-29 | **D85 — a slash command is a tool call, and it had no gate** | M6-1, found by writing D82's reasons rather than by looking for it. Sixteen of the seventeen routes had a sentence that made them reversible or a sentence that made them dangerous; `/api/command` had neither, because it is two things wearing one syntax. Core's own commands set a mode or a pin — one word to change back. **A plugin's command is a tool call under a short name**, and it was reaching `callTool` directly while the identical call from an action button and from the agent loop both went through `rule()`. It goes through the same ruling now, asked in two steps the way `/api/action` asks: this request carries no stream to put a question down, so the first call answers `ask` and the second carries the person's yes, and `blocked` still has no second call. Nothing about the two commands that exist changes — both declare `readOnlyHint` and both still run unasked. **The entry that could not be written is the finding.** With the reason optional, `/api/command` would have joined the safe list as a bare path and the hole would still be open; the rule caught something on the day it was written, which is the argument for having it. |
| 2026-08-29 | **D84 — a skill a model wrote is not a skill you agreed to** | M6-9. A plugin arrives installed and not enabled (D73); a skill arrives live. That is a hole exactly where it matters most, because a **learned** skill is written by a model, after a task, about what it thinks it just learned — the one thing in this product that starts working without anybody asking for it. Three records, because they have three lifetimes: **pending** (transient — waiting on a human), **provenance** (permanent, written once at creation — hand-written, bundled, learned, or installed), **preauth** (consumed once — *yes, to this exact name*, said in advance). Provenance is its own permanent record because the predecessor tried to read authorship out of a usage field, found it meant *is this curator-managed*, and could not recover rows written before the marker existed. So **a skill with no provenance is shown as unknown, never guessed** — the same rule as the catalog's honesty flags. Two existing rules restated where the revise-and-recheck loop lives: the checker is **code, never a model**, because an LLM checking a self-authored skill makes the checker the unauditable thing it exists to catch; and the loop asks the ceiling **before** each dispatch, because a checker that keeps failing and an author that keeps trying is a loop spawning fresh calls — the one shape a ceiling checked afterwards never catches. |
| 2026-08-29 | **D83 — `table` is the eleventh widget; `file` and `graph` are refused for now** | M6-3. `ui-schema.md` promised that an eleventh widget *"is a conversation"*, and this is it, held rather than skipped. What the ten cannot express is **a list of things with actions on each one** — and the evidence is behavioural, not aesthetic: the previous dashboard hand-wrote that same object four times, its second copy admitting in a comment that it *"mirrors SkillsTab.tsx's own shape, since the lifecycle is identical by design"*. Four independent copies of one shape is the strongest case this schema will ever be handed. A row action **is** an `action` — the same permission gate, the question beside the row — so the destructive half invents nothing. `file` and `graph` have one user each, which is this schema's own bar for **no**; both are deferred to the task where their single user is the evidence, rather than granted for sounding useful. The bar is only worth having if it is applied when it is inconvenient. |
| 2026-08-29 | **D82 — a route that destroys something says so, and a test proves there is no third kind** | M6-1. Core serves twelve `POST` routes and has no rule about which of them can destroy something. The answer is the predecessor's: refuse without an explicit `confirm`, or be on a list with a **written reason**, and a test that walks the *real* routes rather than a list maintained beside them — so a route added tomorrow is covered by nobody remembering anything. Its own note recorded the hole it left: the safe-list was keyed globally by `(path, method)`, so one router's harmless `/approve` would wave through another's destructive one. That **cannot happen here**, because core's router is a single flat match on the path, and it is recorded now against the day somebody splits it. Deliberately **not an eleventh invariant**: the ten are about the plugin contract and what survives a folder being deleted, and padding a named set with an unrelated member costs more than it buys. |
| 2026-08-29 | **D81 — there is a control surface, and core does not know what is on it** | M6. The chat window answers *talk to it*; the settings pane answers *configure one plugin*. Neither answers the questions that arrive on day thirty — **what has this been doing, what did I say yes to, what does it know, which of these did I install** — because those are records you read, not values you change. The evidence is a predecessor rather than a guess: the first Alexia's dashboard shipped nine panels over 237 commits and learned which ones get opened. **Four of the seven worth rebuilding are not core's**: memory, voice and commitments belong to plugins. That dashboard listed all nine by hand in one file, with a 480-line panel for a single text-to-speech vendor living in its own source tree — this project's founding complaint arriving through the back door, not a feature you cannot remove but a feature core cannot stop naming. So core contributes only the tabs whose data core owns, every other tab is declared by the plugin that owns it, and the gate is M0-G one screen further in: **delete a plugin with the dashboard open and its tab goes with it.** A control surface is where an architecture like this usually breaks, because it is the one screen that has to know about everything at once. |
| 2026-08-28 | **D80 — the app exists, and the only way to find out was to run it** | M5-1 to M5-5. The shell is 135 lines of Rust against a 300-line budget, and it does four things: pick a free port, spawn the core sidecar on it, point two windows at it, and own the tray, the hotkey, autostart and single-instance. Everything else is on the other side of an HTTP port, which is what makes the budget keepable rather than a wish. **The port is chosen by the shell rather than read back from the core**, because parsing a sidecar's stdout means no window can exist until Node has finished booting, and a blank window in front of somebody who has just double-clicked is worse than a race that has never once been lost. Two bugs came out of running the built app and could not have come from anywhere else. Tauri's `resources/*` copies files and not directories, so the shell and every plugin were silently missing from the bundle. And core's shell lookup walks *up* from wherever it is running — from inside the bundle it found `src-tauri/ui`, Tauri's own placeholder frontend, before the real one, and served a page whose comment said *if you are looking at this, a window was built with the wrong URL*: true, and useless. The folder has a name that cannot collide now, and the packaged layout is checked first. This is D75 again one layer up: **the failure mode of a build artefact is a quiet substitution, and only starting it sees one.** |
| 2026-08-28 | **D79 — the cold-install gates are deferred, and the boxes stay empty** | The owner's instruction was to build the whole app and tune afterwards. So M2-8, M3-8 and M5-6 are unticked, and M3-G with them. That is the honest state rather than a formality: **the two-minute claim is the one thing this entire product is built on**, and nobody has yet sat a person in front of it with a clock. What exists is everything those tests would measure — an NSIS installer that builds, a first run whose five steps are all on screen, a signed-release workflow that has never been run. What does not exist is the measurement. A ticked box here would be the first lie in the document. |
| 2026-08-28 | **D78 — channels stay unformalised at n=3, and the reason is sharper than the deferral was** | This document deferred `channel` at n=2 on the grounds that an abstraction invented then is usually wrong in ways you only find at n=3. Revisited with three surfaces built, the answer is still no, and now it is for a specific reason: they do not share **who owns the conversation, or where a permission question goes**. The chat shell owns a session and can stop mid-task to ask. Telegram owns its own store and deliberately has no agent loop, because on a phone chat the honest answer to *where does the permission prompt appear* is **nowhere** — so that surface gets a model call and no tools, rather than a shared abstraction with a hole exactly where the safety is. And voice is not a channel at all; it is a capability core calls. A `channel` type would have had to paper over the one difference that matters. What did generalise got a name instead, which is D77. |
| 2026-08-28 | **D77 — M4 broke the contract exactly once, and lazy spawn was where** | The milestone exists to find the crack before anyone else depends on the shape, and it found one. **Lazy spawn assumes every plugin is something core calls into.** Quiet for five minutes, the process exits, the next call brings it back — true of every plugin written before this and false the moment messages arrive from *outside*. A bridge holding a long poll open is not idle when nobody has typed at it for an hour; it is working, and stopping it is indistinguishable from switching it off. The answer is one additive field, `lifetime: "resident"`, and `alexia_protocol` 2. Two things about how it was added matter more than the field. It is **opt-in and declared**, because it costs memory forever and the library has to be able to say so. And **invariant 9 was narrowed rather than dropped**: a plugin that has not declared it still runs no process, the check proves both halves, and it prints the resident list so a new name appears in a diff. A rule that quietly widens to accommodate the first thing that breaks it is a rule that will accommodate the second and the third. |
| 2026-08-28 | **D76 — an invariant that only runs where you do not look is not a check** | A resume found `pnpm check` red — one file, in teardown, `EPERM` deleting its own data directory — and pulling on it found two things. The first: **`stop()` did not wait for the plugin core had already forgotten.** A folder that disappears is stopped and dropped from the map in the same breath, and the stop is deliberately not awaited, because noticing a deletion has to run at the speed of the filesystem rather than at the speed of a process agreeing to exit. But once the entry is gone, `stop()` has nothing left to wait *for* — so it resolved while that process was still running, and **forgotten is exactly why nothing else would ever stop it**. Reproduced deterministically: `await stop()`, pid still alive, and the data directory refusing to delete, because on Windows a directory that is a live process's working directory cannot be removed at all — the same fact D58 moved the working directory out of the plugin folder for, arriving one directory over. The fix is a set of shutdowns already under way, awaited by `stop()` and by `purge()`, which had the identical hole on the path that matters most: a folder deleted by hand before the delete button is pressed leaves nothing to await, and then purge removes the directory that process is sitting in. The second finding is the larger one. **Invariant 2's CI job — core passes its full suite with `plugins/` empty — had been red for two milestones.** Four test files added at M15 and M2 use the repo's own plugins as fixtures and never joined `needPlugins`, and nothing on this machine could say so, because `pnpm check` runs with `plugins/` present, which is the one condition that check exists to remove. There is now a `pnpm check:no-plugins` that moves the folder aside and puts it back whatever happens. The ten checks are named in this document as the thing that keeps the thesis true when nobody reads every line; a check whose only runner is a push is not doing that job. |
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
will answer it. Planning the control surface on 2026-08-29 raised **G7 and G8**, both about the
same boundary from opposite sides: whether the ten widgets can carry a file, and whether a
plugin ever draws something core cannot. Neither blocks M6, and both are attached to the task
whose only user is the evidence.

The **to do, not decide** list is now attached to tasks in [`plan.md`](./plan.md) rather than
floating: licence files before the first public push (P0-1), the agentskills.io spec (P0-5,
read), Anthropic's usage terms (M4-7, researched — written confirmation outstanding), provider
terms before free-tier pooling ships (M1-6), and the manifest schema and wire protocol as
documents before building against them (P0-3, P0-4).

New questions will keep appearing as building starts. They go in `questions.md`, get answered,
and land here — same loop as today.
