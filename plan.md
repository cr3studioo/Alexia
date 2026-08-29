# Alexia — the build plan

> **What this file is.** The executable half of the project. [`Alexia.md`](./Alexia.md) says
> *what* we are building and *why*; this file says *how*, *in what order*, and *what is done
> so far*. It is written to be picked up cold: read it top to bottom and you know exactly
> what to do next.
>
> **Precedence.** Alexia.md wins on product and architecture. This file wins on sequence,
> tooling and task state. Where this file records a decision **dated later** than Alexia.md,
> the later decision wins — and it gets copied into Alexia.md's decision log the same day, so
> the two never drift.
>
> Companion files: [`Alexia.md`](./Alexia.md) (source of truth) ·
> [`questions.md`](./questions.md) (open questions).
>
> Written 2026-08-27. Repo: `github.com/cr3studioo/Alexia`.

---

## How to run this plan

Read this section at the start of every session. It is four lines long on purpose.

1. **Read [`Alexia.md`](./Alexia.md)**, then this file. Alexia.md is why; this is how.
2. **Find the first unchecked box** in the *Status board*. That is the current task. Open its
   task block further down for the detail.
3. **Build it. Run `pnpm check`. It must be green.** Then commit, tick the box, move on.
4. **Keep going.** Do not stop between tasks.

### When to stop

Stop — and only stop — for one of these:

| Stop | Why |
|---|---|
| A milestone's **Done when** gate is reached | Report it, show the evidence, wait. |
| A task marked **`[GATE]`** | It needs a human: a cold-install test, an approval, a decision. |
| Anything **irreversible or outward-facing** | Making the repo public, first push, publishing the registry, spending money, installing system software, emailing anyone. Ask first, every time. |
| **Genuinely blocked** | Say what is blocking, say what you tried, propose two ways forward. |

Everything else: keep working. *(Autonomy level chosen 2026-08-27 — run the whole milestone.)*

### The rules that do not bend

- **A task is done when its acceptance criteria pass**, not when it looks done. Drift is the
  named failure mode of this project (Alexia.md, *Working shape*) and the acceptance criteria
  are the only defence.
- **`pnpm check` green before every commit.** It runs lint, types, unit tests and the ten
  invariant checks. A red check is a stop, not a note-to-self.
- **New question → [`questions.md`](./questions.md).** Answered question → Alexia.md's decision
  log **and** this file's changelog. Same loop the project has run since day one.
- **Write the spec before the code** for anything on the contract. The spec is the brief; a
  vague brief produces vague code, and nobody is reading every line. (Alexia.md, *Who is
  writing this*.)
- **Never let core name a plugin.** If you are about to type `voice` inside `packages/core`,
  you have found a missing capability, not a shortcut.

### Resuming after a gap

5–15 hours a week means gaps. Coming back should cost five minutes:

```bash
git log --oneline -10        # what happened last
pnpm check                   # is it still green
```

Then the Status board tells you where you are, and the task block tells you what "done"
means. If `pnpm check` is red after a gap, fixing it *is* the current task.

---

## Status board

Tick a box only when the task's acceptance criteria pass. `[GATE]` needs a human.

### Phase 0 — Before any feature code

- [x] **P0-1** `[GATE]` Licences, README, repo public
- [x] **P0-2** Monorepo skeleton and CI
- [x] **P0-3** Spec: the wire protocol (MCP profile + `alexia/*`)
- [x] **P0-4** Spec: `plugin.json` v1 + JSON Schema
- [x] **P0-5** Spec: capabilities, storage, UI schema, skills
- [x] **P0-6** The invariant checklist and the cold-install protocol, as documents

### M0 — The skeleton that proves the thesis

- [x] **M0-1** `@alexia/protocol` — types, schemas, version constants
- [x] **M0-2** Supervisor: spawn, handshake, heartbeat, backoff, lazy spawn, idle shutdown
- [x] **M0-3** `@alexia/sdk` — the plugin-author package
- [x] **M0-4** `plugins/hello` — the plugin that answers
- [x] **M0-5** `plugins/crasher` — the plugin that dies, three ways
- [x] **M0-6** `plugins/vanisher` — the plugin that disappears mid-call
- [x] **M0-7** Manifest loader and capability resolver
- [x] **M0-8** The ten invariant checks, green in CI
- [x] **M0-9** Memory budget harness
- [x] **M0-G** **Done when:** delete a plugin folder while Alexia is running and nothing else notices

### M1 — Core minimum

- [x] **M1-1** Storage: SQLite, migrations, per-plugin namespaces
- [x] **M1-2** Sessions and message history
- [x] **M1-3** Settings store and `SecretStore`
- [x] **M1-4** Provider layer — one OpenAI-compatible interface
- [x] **M1-5** Model catalog: fetch, cache, daily diff, honesty flags
- [x] **M1-6** Free-tier pool adapter (self-hosted)
- [x] **M1-7** Ollama provider (T0)
- [x] **M1-8** The router — tiers, three axes, pins, 429 fallback
- [x] **M1-9** Usage, attribution and caps
- [x] **M1-10** Chat shell
- [x] **M1-11** First-run flow v1
- [x] **M1-12** Slash commands
- [x] **M1-D1** Holding theme — black, grey, and a face *(reduced 2026-08-27, D61)*
- [x] **M1-I1** The crude installer, a folder that double-clicks *(pulled forward from M2-7, 2026-08-28, D65)*
- [x] **M1-13** `[GATE]` Cold-install test #1 *(gate waived 2026-08-28, D64 — the tester half moves to M2-8)*
- [x] **M1-G** **Done when:** a real conversation, routed to a free model, spend showing 0.00 *(carried by M15-G, 2026-08-28, D64)*

### M1.5 — The loop and its rails *(inserted 2026-08-27 — see Change log)*

- [x] **M15-1** The agent loop
- [x] **M15-2** Plugin tools reach the model
- [x] **M15-3** Permission modes and the never-touch list
- [x] **M15-4** The safety checker
- [x] **M15-5** The visible trace and the stop control
- [x] **M15-6** Step-trace trimming
- [x] **M15-7** Ceilings and the spend preview
- [x] **M15-8** A tool vanishes mid-task
- [x] **M15-G** **Done when:** a multi-step task finishes on a free model, every step visible, stop works mid-step

### M2 — Voice, the real proof

- [x] **M2-S1** Spike: Tauri tray + hotkey + overlay on Windows *(de-risking M5)*
- [x] **M2-D1** The visual language *(deferred from M1 2026-08-27, D61)*
- [x] **M2-1** Declarative UI schema v1
- [x] **M2-2** Skills loader (agentskills.io)
- [x] **M2-3** `plugins/voice` — speech to text
- [x] **M2-4** `plugins/voice` — text to speech
- [x] **M2-5** Full lifecycle: install, enable, disable, purge
- [x] **M2-6** Streaming progress over the wire
- [x] **M2-7** The crude installer
- [ ] **M2-8** `[GATE]` Cold-install test #2 *(deferred by the owner 2026-08-28, D79 — build first, time it after)*
- [x] **M2-G** **Done when:** install → talk → delete leaves no residue and not one line changed in core

### M3 — The plugin library

- [x] **M3-1** Registry backend *(built; deploying it is a separate gate — see Gates that need you)*
- [x] **M3-2** Registry client and library UI
- [x] **M3-3** The conformance suite
- [x] **M3-4** Author docs and the scaffold command
- [x] **M3-5** The skills marketplace
- [x] **M3-6** MCP compatibility mode
- [x] **M3-7** Checksums and signing
- [ ] **M3-8** `[GATE]` Cold-install test #3 *(deferred with M2-8, D79)*
- [ ] **M3-G** `[GATE]` **Done when:** someone who is not you builds a working plugin from the docs alone

### M4 — Contract generality

- [x] **M4-1** `plugins/telegram`
- [x] **M4-2** `plugins/computer` — computer control
- [x] **M4-3** `plugins/memory` — long-term recall
- [x] **M4-4** `plugins/persona` — the personality node
- [x] **M4-5** Learned skills
- [x] **M4-6** Local media generation
- [x] **M4-7** `plugins/claude-code`
- [x] **M4-8** Channels: formalise or do not — **do not** (D78)
- [x] **M4-9** Contract freeze v1 — `alexia_protocol` 2
- [x] **M4-G** **Done when:** voice, Telegram and computer control all work with no special-casing in core

### M5 — The app

- [x] **M5-1** The Tauri shell
- [x] **M5-2** Tray, hotkey, overlay, autostart
- [x] **M5-3** `[GATE]` The signed installer — the workflow exists; the certificate and the publish do not
- [x] **M5-4** Automatic updates
- [x] **M5-5** First run, final
- [ ] **M5-6** `[GATE]` Cold-install test #4 — the real one *(deferred with M2-8, D79)*
- [ ] **M5-G** `[GATE]` **Done when:** a non-technical tester installs cold and reaches a working conversation, never seeing a terminal

### M6 — The control surface *(inserted 2026-08-29 — see Change log)*

- [x] **M6-1** The route guard, and the check that keeps it
- [x] **M6-2** The control view, and a tab list nobody writes by hand
- [x] **M6-3** `table` — the eleventh widget, and the conversation the spec asked for
- [x] **M6-4** Skills, learned skills and tools — three panels, one widget
- [x] **M6-5** The trace, with a memory
- [x] **M6-6** `plugins/voice` declares a panel — and the `file` question
- [x] **M6-7** `plugins/memory` declares a panel — and the `graph` question
- [x] **M6-8** `plugins/commitments` — the panel for a plugin core has never heard of
- [x] **M6-9** The consent ladder — pending, provenance, preauth
- [x] **M6-10** The command palette
- [x] **M6-G** **Done when:** delete `plugins/memory` with the control view open and its tab goes with it

### M7 — What version 1 knew *(inserted 2026-08-29 — see Change log)*

- [x] **M7-1** Nothing leaves this machine unread — egress redaction
- [x] **M7-2** One id, four records
- [x] **M7-3** Memory that captures without being asked
- [x] **M7-4** A voice that is yours — cloning, and the engine it costs
- [ ] **M7-5** A button in Telegram, and somewhere else to land
- [ ] **M7-6** Three tiers, and the cheapest one has no model in it
- [ ] **M7-G** **Done when:** a free-model request is provably stripped, a cost is traceable to the run that spent it, and Alexia remembers something nobody told it to

---

## What changed on 2026-08-27, after Alexia.md was written

Four decisions and a set of measured facts. All four are in Alexia.md's decision log too.

### D50 — The wire protocol is MCP, with a thin Alexia layer on top

Alexia.md decided *JSON-RPC 2.0 over stdio* with four message types of our own
(`call`/`event`/`stream`/`hello`). **The Model Context Protocol is that decision, already
specified.** MCP is JSON-RPC 2.0 over stdio with an `initialize` handshake and version
negotiation — and it covers considerably more of the contract than we would have written
ourselves in the same time.

| What Alexia needs | What MCP already has |
|---|---|
| `hello`, the version handshake | `server/discover` + a per-request `_meta` version envelope, with a spec'd mismatch path — **see D55, this is not `initialize` any more** |
| `call`, core → plugin | `tools/call` |
| `call`, plugin → host, for a model call | `sampling/createMessage` |
| plugin asks the user something | `elicitation/create` |
| `event` | `notifications/*` |
| `stream` — download progress | `notifications/progress` against a `progressToken` |
| a stop control that always works | `notifications/cancelled` |
| **tools can vanish mid-task** | `notifications/tools/list_changed` |
| where Alexia may work (folder scope) | `roots` + `roots/list_changed` |
| plugin logging | `notifications/message` |
| **safe vs risky, for the permission modes** | tool `annotations`: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` |
| plugins registering slash commands | `prompts`, which carry name, description and arguments |
| heartbeat | `ping` |

That last-but-one row is the one to notice. *Ask before anything risky* — "reading and
searching run freely; anything that changes, sends or spends waits" — is `readOnlyHint`
read straight off the tool definition. The permission model we specified has a field
waiting for it.

**What MCP does not have, and stays ours** — the manifest, the settings schema, the storage
namespace and purge contract, `requires`/`provides` between plugins, install/enable/disable
lifecycle, bundled skills, and per-plugin spend attribution. These live in `plugin.json`
(out of band, read before the process ever spawns) and in a small `alexia/*` method
namespace. Details in *The contract* below.

**What this buys, beyond the weeks not spent writing a wire protocol.** There are on the
order of ten thousand MCP servers in the official registry alone. Any of them can be added
to Alexia as a tool plugin on day one. That is the same argument that carried
agentskills.io — *the marketplace starts non-empty* — applied to the other marketplace.
Alexia now inherits both ecosystems instead of competing with them.

> **The cost, stated plainly.** MCP is someone else's spec and it moves; the current
> revision is `2026-07-28` and there have been four before it. We pin a revision, we do not
> chase it, and the SDK's own version negotiation means an older plugin declines to load
> with a readable message rather than crashing — which is exactly the property Alexia.md
> already required of the handshake. Upstream churn is a known, bounded cost. Writing and
> documenting a wire protocol from scratch is an unbounded one.

### D51 — Free means free, by layering three sources

Measured, not assumed. **OpenRouter's free tier is 20 requests per minute and 50 requests
per day** on an account that has never spent money — 1,000 a day once $10 has been spent,
ever. One agent task is 10–30 model calls. So Combined mode on a zero-spend account is
about **two to five agent tasks a day** before it starts returning 429s.

That is the whole product promise, and left alone it does not hold. Three layers, in this
order:

1. **Pool the free tiers.** Alexia's own self-hosted adapter (Alexia.md, *Model providers*)
   moves from *someday* to **M1-6**, because it is what makes the claim true. Groq alone is
   30 rpm / 14,400 a day; Cerebras the same; Google AI Studio 15 rpm / 1,500 a day. Pooled,
   that is tens of thousands of free requests a day rather than fifty. Nearly all of them
   are OpenAI-compatible, which is the interface core is being written against anyway.
2. **Route mechanical steps to the local model.** Listing files, extracting a field,
   formatting a result — T0 handles these and they are most of the steps. This is the
   per-step tiering Alexia.md already specified, now with a second reason to exist.
3. **Say the $10 out loud.** One lifetime $10 takes OpenRouter from 50 to 1,000 a day and
   never expires. Optional, never required, stated in plain words in settings — not a
   surprise the user discovers at their first 429.

> **And the honesty flag that came out of measuring this.** Free tiers are often funded by
> the prompts you send them. The catalog therefore carries `trains_on_your_data` per model,
> the free-tier pool shows it, and the privacy mode picker uses it. A product with a
> *wording discipline, forever* rule about Local mode cannot quietly route a private-feeling
> conversation to a provider that trains on it.

### D52 — Autonomy: run the whole milestone

Claude Code works continuously through a milestone's tasks. It stops at the milestone gate,
at any `[GATE]` task, at anything irreversible or outward-facing, or when blocked. The
acceptance criteria on each task and `pnpm check` are what make that safe.

### D53 — Claude Code plugin: build it, ship it off by default

Anthropic's Consumer Terms bar accessing the services "through automated or non-human means,
whether through a bot, script, or otherwise" except via an API key or where otherwise
permitted, and bar commercial use of a consumer subscription. Cutting the other way,
`claude setup-token` is an Anthropic-shipped feature explicitly for non-interactive use, and
a person driving their own installed CLI with their own credentials is ordinary use of a
product they pay for. For a *distributed* product wrapping it, this is genuinely unsettled.

So: it is a plugin (it always was), it ships **disabled**, it is never auto-enabled, and
**the user runs `claude setup-token` themselves — Alexia never automates a login**. A
plain-language notice at enable time says what it does and whose terms apply. Written
confirmation from Anthropic is sought before it appears enabled in any public release. If
the answer is no, it is one folder to delete — which is the entire thesis, applied to
ourselves.

### D54 — The agent loop gets its own milestone

Alexia.md calls the loop "the product" and "the biggest and only real exception to
*everything is a plugin*" — and then does not put it in a milestone. M1's list is sessions,
settings, stats, catalog, router, chat shell; M2 is voice. The loop has no home.

Left there it would be absorbed into M1, which is already the biggest chunk, and M1's *done
when* — a conversation on a free model — would quietly stop meaning anything. So the loop
and its rails become **M1.5**, with a gate of their own. Numbering stays otherwise
untouched, so Alexia.md's roadmap still reads straight.

### D55 — MCP `2026-07-28` deleted `initialize`, and the pin is two revisions wide

*Answers G3.* D50 was written from the shape MCP had at `2025-11-25`. Reading the pinned
revision's schema before writing the spec turned up a change big enough to correct D50's
own table:

- **There is no `initialize` handshake.** Protocol version, client identity and client
  capabilities travel in `params._meta` on **every request**, under the reserved
  `io.modelcontextprotocol/*` keys. Capabilities are per-request and a server **must not**
  infer them from an earlier one.
- **`server/discover` replaces it.** Servers MUST implement it; clients MAY call it. It
  returns `supportedVersions[]`, `capabilities` and optional `instructions`.
- **A server may not send an unsolicited notification** — on stdio exactly as on HTTP. The
  client opens a long-lived `subscriptions/listen` stream and names the notification types
  it wants. This is how `notifications/tools/list_changed` reaches core now.
- Version mismatch has a code of its own: `-32022`, carrying `data.supported[]` and
  `data.requested`.
- `logging/setLevel` is gone, replaced by a per-request `_meta` log level — itself already
  deprecated (SEP-2577) with a twelve-month window.

This is a **better** fit than the handshake was. A plugin that is spawned lazily, shut down
when idle and restarted after a crash has no long-lived session to initialise, and under
the 2026 rules it does not need one. `server/discover` is a single round trip that proves
the process is alive, speaks MCP, and says which revisions it takes.

`@modelcontextprotocol/server` 2.0.0 serves both eras — the 2026 per-request envelope and
the 2025 `initialize` handshake it calls *legacy* — so supporting two revisions costs one
code path in the SDK rather than two in ours.

**The policy, which is the actual answer to G3: core accepts exactly two revisions at a
time — the pinned one and its immediate predecessor.** Today that is `2026-07-28` and
`2025-11-25`. A new revision becomes the pin in a minor release; the old predecessor drops
one release later; the registry warns affected authors before their plugin stops loading.
Pin-and-hold was the alternative and it fails the same way every frozen dependency does:
quietly, and then all at once.

---

## Verified facts, and how to re-verify them

Everything below was measured on **2026-08-27**. Numbers move; the commands do not. Re-run
before relying on any of them.

### This machine

| | |
|---|---|
| CPU / RAM | AMD Ryzen 5 3600, 16 GB |
| GPU | RTX 4060 Ti, **8 GB VRAM** |
| Installed | Node 24.16.0, pnpm 10.10.0, Rust 1.96.1, git 2.54, gh 2.97 (authed as `cr3studioo`), Python 3.11.15, Ollama 0.32.5, Claude Code 2.1.247 |
| Not installed | Docker, Bun |

8 GB VRAM is the useful number. It comfortably runs a 7–9B model at Q4 (the T0 tier and the
safety checker), Whisper base/small, Piper or Kokoro TTS, and SDXL at 1024×1024 with
`--medvram`. It does not run a 30B+ model. **Keep the local context window at 8k–16k** — a
32k window on a 7B Q4 model overflows 8 GB.

> This machine is also the *upper* bound for what Local mode can assume, not the average.
> The cold-install tester's machine is the one that matters.

### The repo

`github.com/cr3studioo/Alexia` exists, is **private**, has **zero commits**, and has **no
licence**. Alexia.md requires public from the first commit and the licence set before the
first push. That is P0-1, and it is a `[GATE]`.

### Free model reality

```bash
curl -s https://openrouter.ai/api/v1/models | python -c "import json,sys; d=json.load(sys.stdin)['data']; \
print(len(d),'models'); f=[m for m in d if float(m['pricing']['prompt'])==0]; print(len(f),'free'); \
print(len([m for m in f if 'tools' in (m.get('supported_parameters') or [])]),'free with tools')"
```

On 2026-08-27: **417 models, 20 free, 17 free with tool-calling support**, several at 256k–1M
context. Free agent mode is not a hope; it is a list you can print today. The constraint is
request *count*, not capability — hence D51.

Free tiers worth pooling, all OpenAI-compatible, none requiring a card:

| Provider | Limits | Base URL |
|---|---|---|
| Groq | 30 rpm · 14,400/day | `https://api.groq.com/openai/v1` |
| Cerebras | 30 rpm · 14,400/day · 60k tpm | `https://api.cerebras.ai/v1` |
| Google AI Studio | 15 rpm · 1,500/day (Flash) | `https://generativelanguage.googleapis.com/v1beta/openai/` |
| Mistral | 1 rps · ~1B tokens/month | `https://api.mistral.ai/v1` |
| NVIDIA NIM | ~40 rpm, credit-replenishing | `https://integrate.api.nvidia.com/v1` |
| GitHub Models | 10–15 rpm · 50–150/day | `https://models.inference.ai.azure.com` |
| OpenRouter | 20 rpm · 50/day (1,000 after $10 lifetime) | `https://openrouter.ai/api/v1` |

Two rules from Alexia.md apply and do not bend: **self-hosted only** — keys and prompts stay
on the machine, never through a hosted proxy — and **check each provider's terms** before
pooling ships in a public release. A third rule joins them from D51: **record whether each
one trains on your data**, and show it.

### MCP

- Current spec revision **`2026-07-28`**; prior revisions `2025-11-25`, `2025-06-18`,
  `2025-03-26`, `2024-11-05`. Read the schema itself, not a summary of it — see D55 for
  what changed:
  `curl -s https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts | grep 'method: "'`
- **`2026-07-28` has no `initialize`.** `server/discover`, a per-request `_meta` envelope,
  and `subscriptions/listen` for every server-to-client notification. Error `-32022` on a
  version mismatch. D55.
- **A running process's working directory cannot be deleted on Windows.** Its *files* can
  be, but `rmdir` on the directory itself returns `EPERM` while any process has it as a cwd.
  With the cwd elsewhere the same folder deletes cleanly mid-call and the child carries on.
  Measured 2026-08-27 (D58) — this is why `entry` spawns with the working directory on a
  core-owned directory and the plugin folder in `ALEXIA_PLUGIN_DIR`.
- **`2026-07-28` also has no server-to-client request channel**, and the SDK does not ship
  it as the default. Measured on 2026-08-27 while building M0-2 (D57), all three:
  ```bash
  node -e "import('@modelcontextprotocol/server').then(m=>console.log(m.LATEST_PROTOCOL_VERSION, m.SUPPORTED_PROTOCOL_VERSIONS))"
  # -> 2025-11-25 [ '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07' ]
  ```
  `2026-07-28` is opt-in via `supportedProtocolVersions`; over stdio it is served only
  through `serveStdio()` (a plain `server.connect(new StdioServerTransport())` answers
  `server/discover` with `-32601`, and a negotiating client falls back to `2025-11-25`); and
  on that era a client **drops** any inbound request — *"Dropped inbound request
  'alexia/host/info': not servable on this connection's protocol era"*. The regression test
  is `packages/core/test/supervisor.test.ts`, "the newer MCP revision connects, and cannot
  reach back into core".
- SDK v2 is split: `@modelcontextprotocol/server` and `@modelcontextprotocol/client`, both
  at 2.0.0. (`@modelcontextprotocol/sdk` 1.30.0 is the v1 line.)
- The official registry is a public, cursor-paginated API:
  `https://registry.modelcontextprotocol.io/v0/servers` — usable for M3-6.

### Package versions that exist today

`@modelcontextprotocol/server` 2.0.0 · `@modelcontextprotocol/client` 2.0.0 · `zod` 4.4.3 ·
`grammy` 1.46.0 · `ollama` 0.6.3 · `@tauri-apps/cli` 2.11.4 · `@tauri-apps/api` 2.11.1 ·
`vitest` 4.1.11 · `tsx` 4.23.12 · `dependency-cruiser` 18.2.0 · `execa` 10.0.1 ·
`hono` 4.13.5 · `cross-keychain` 1.1.0 · `@yao-pkg/pkg` 6.22.0 · `gray-matter` 4.0.3 ·
`pino` 10.3.1 · `chokidar` 5.0.0.

---

## The parts list

Alexia.md's instinct is right: nearly everything here is a solved problem wearing a
different name. What follows is what to take, what to leave, and why. **Do not rebuild a row
in this table without a reason written down.**

### The wire, the plugins, the skills

| Need | Take | Instead of | Why |
|---|---|---|---|
| Plugin wire protocol | **MCP**, revision pinned, via `@modelcontextprotocol/{server,client}` | writing `call`/`event`/`stream`/`hello` | D50. Framing, handshake, negotiation, progress, cancellation, sampling, elicitation, roots, list-changed — all specified and shipped. |
| Skill format | **agentskills.io `SKILL.md`** | a format of our own | Already decided in Alexia.md. `name` + `description` required; `license`, `compatibility`, `metadata`, `allowed-tools` optional; **the `name` must match the folder name**. Progressive disclosure is built into the spec: ~100 tokens of metadata always loaded, body on activation, `references/` on demand. Validate with `skills-ref validate`. |
| Skill frontmatter parsing | `gray-matter` | hand-rolled YAML splitting | Frontmatter must start at byte 0; `gray-matter` gets the edge cases right. |
| Manifest shape | **VS Code's `contributes.configuration`**, narrowed | JSON Schema forms | Proven at enormous scale for exactly this problem: a third party declares settings, the host renders them. Take the shape (`type`, `enum`, `default`, `description`, `order`), not the size. |
| Settings rendering | **~8 hand-written widget types** | `react-jsonschema-form`, JSON Forms | The whole point of the declarative schema was that *a plugin cannot style itself wrong because it never styles itself*. A general JSON Schema renderer re-opens that door and adds 175 KB. Widgets: `text`, `password`, `number`, `toggle`, `choice`, `multi-choice`, `path`, `status`, `progress`, `action`. If a plugin needs a tenth, that is a conversation, not a config option. |
| Capability naming | LSP / MCP style dotted namespaces | ad-hoc strings | `voice.transcribe`, `audio.input`, `fs.own_dir`. Already the convention in Alexia.md. Registry lives in `docs/spec/capabilities.md`. |

### Core

| Need | Take | Instead of | Why |
|---|---|---|---|
| Database | **`node:sqlite`** (built in, Node 22+) | `better-sqlite3` | No native compile, no postinstall, no toolchain — which matters enormously for a product whose pitch is a double-click. `better-sqlite3` is faster on a hot path we do not have. Transactions are explicit `BEGIN`/`COMMIT`; wrap them once in a helper. |
| Provider layer | **one OpenAI-compatible client**, hand-written, ~200 lines | an SDK per vendor | Alexia.md's own mitigation for keeping the provider-in-core exception bounded. Verified: every free provider above speaks this shape. |
| Local models | `ollama` npm package | HTTP by hand | Also gives model pull with progress, which the first-run download needs. |
| Model catalog | OpenRouter `/api/v1/models` | a hand-maintained list | Carries per-token pricing including the free variants, context length, `supported_parameters` (so you can filter on `tools`), and modality. This endpoint is what makes a self-updating catalog possible at all. Cache to disk; never break because it changed shape. |
| Secrets | `cross-keychain` at M1 → **Tauri Stronghold / the Rust `keyring` crate** at M5 | `keytar` | `keytar` is archived. `cross-keychain` needs no native module (CLI fallback to Windows Credential Manager), so it survives being bundled. Put both behind one `SecretStore` interface and the M5 swap is one file. |
| Validation | `zod` v4 | `ajv` | The MCP SDK already uses zod; one schema library, and manifests get a generated JSON Schema for free via `z.toJSONSchema`. |
| Process spawning | **`StdioClientTransport`**, from the MCP client | `execa`, `child_process` | Changed at M0-2 (D56): the MCP client's stdio transport already spawns the plugin, wires stdio, exposes `pid` and `stderr`, and escalates stdin-close → `SIGTERM` → `SIGKILL`. A second spawner would have meant replacing the transport to gain nothing. `execa` comes back the day a *plugin* spawns a binary of its own — whisper.cpp at M2. |
| Logging | `pino` | `console.log` | **stdout is the wire.** Every plugin log line must go to stderr or it corrupts JSON-RPC framing. Configure this once, centrally, and put it in the author docs in bold. |
| Registry backend | **Hono on Cloudflare Workers + D1** | a VPS, Supabase, Fly | Free tier covers this by a wide margin (5 GB, 5M row reads/day) and there is no server to keep alive. Alexia.md's brief is "a list with a revoke button" and this is the smallest thing that is one. |

### The plugins

| Need | Take | Instead of | Why |
|---|---|---|---|
| Speech to text | **`whisper.cpp`**, its CLI binary spawned as a child process | a Python stack, a native Node addon | No Python, no compile step on the user's machine, CPU and CUDA both, ships as a binary. And a plugin that spawns its own binary *is* the architecture — audio never crosses the core boundary, exactly as Alexia.md specifies. |
| Text to speech | **Piper** (lowest latency, tiny voices) or **Kokoro-82M** (Apache-2.0, ~327 MB, clearly better prosody) | a cloud TTS | Offer both as a `model_size`-style choice; Piper is the default for the first-run download budget, Kokoro the upgrade. |
| Telegram | **grammY** | Telegraf | TypeScript-first with types that actually hold; Telegraf's were retrofitted. Long polling means no webhook, no port, no inbound firewall — which matters for the same reason stdio beat a localhost port. |
| Local image generation | **ComfyUI headless**, driven over its API | bundling a diffusion runtime | Handles 8 GB VRAM better than the alternatives, is already a separate process, and its API is a natural plugin boundary. Note the SDXL VAE fp16 fix (`madebyollin/sdxl-vae-fp16-fix`) — without it, 8 GB cards produce black images. |
| Claude Code | the installed `claude` CLI + `claude setup-token` | automating a browser login | Anthropic's own mechanism for non-interactive use; token is valid ~12 months. See D53 for the posture. |

### The shell and the build

| Need | Take | Instead of | Why |
|---|---|---|---|
| Desktop shell | **Tauri v2** (`@tauri-apps/cli` 2.11.4) | Electron | ~10 MB installer against 100+, signed auto-updates, native tray and global shortcut. Official plugins: `global-shortcut`, `single-instance`, `autostart`, `updater`, `store`, `stronghold`, `positioner`. |
| Overlay behaviour | prove it with **M2-S1** before depending on it | assuming it works | Tauri v2 has open bugs where `alwaysOnTop` and the blur-to-hide event stop working after a `hide()`/`show()` cycle — precisely the overlay's whole life cycle. Read `tauri-plugin-spotlight` for the approach; it is macOS-only, so Windows is ours to solve. A one-day spike at M2 is cheap; discovering it at M5 is not. |
| Shipping the TS core | `@yao-pkg/pkg` at M2 → re-evaluate **Node SEA** at M5 | asking the user to install Node | The maintained fork of `vercel/pkg`. Node's `--build-sea` one-step build landed in 25.5; on Node 24 the SEA path still needs the old multi-step flow, so `pkg` is the pragmatic choice now. **Revisit at M5** — by then Node 26 is likely and SEA is the cleaner artifact to sign. |
| Free bonus of bundling Node | expose the bundled runtime to plugins | making authors ship a runtime | A plugin whose manifest says `"run": "node"` gets *Alexia's* Node. Plugin users never install Node. Say this loudly in the author docs — it is a real advantage over every extension system that assumes a system runtime. |
| Boundary enforcement | **`dependency-cruiser`** + a bespoke grep test | code review | The invariant is a CI property, not a habit. `dependency-cruiser` forbids `packages/core → plugins/*` structurally; the grep catches the string `"voice"` appearing in a switch statement, which no import graph would. Both, not either. |
| Windows code signing | **SignPath Foundation** (free for OSS, HSM-held key, GitHub Actions integration) | buying an EV cert, Azure Trusted Signing | Azure Trusted Signing is ~$10/mo and, as of Feb 2026, restricted to individual developers in the US and Canada. SignPath signs OSS free and verifies the binary came from the public repo. Publisher shows as *SignPath Foundation*, and an OV certificate still faces SmartScreen until reputation builds — say that in the release notes rather than being surprised by it. |
| Tests | `vitest` | jest | Fast, ESM-native, and the invariant checks are just tests. |

### What was looked at and left

- **`react-jsonschema-form` / JSON Forms** — see the settings row. Consistency was the point.
- **Existing free-tier proxy projects (FreeLLMAPI, OmniRoute)** — Alexia.md already rejected
  depending on one. The verified provider table above is the useful part of them; take the
  data, write the adapter.
- **Electron** — a 100 MB installer in a product whose demo is the install.
- **`keytar`** — archived.
- **Building on Hermes or OpenHands** — Hermes already has MCP extensibility, SQLite memory,
  agentskills.io skills and gateways for twenty-plus platforms. Alexia is not going to
  out-feature it and should not try. What it does not have is *delete the folder, nothing
  breaks* verified in CI, and a double-click install for someone who will never open a
  terminal. **That is the whole differentiation, and both live in the plan above.** Adopting
  MCP and agentskills.io means Alexia shares an ecosystem with it rather than splitting one.

---

## Repo layout

```
Alexia/
  CLAUDE.md                 # five lines: read Alexia.md, read plan.md, start
  Alexia.md                 # source of truth — what and why
  plan.md                   # this file — how and in what order
  questions.md              # open questions
  LICENSE                   # AGPL-3.0 — the app
  README.md                 # with the UNSTABLE CONTRACT banner
  pnpm-workspace.yaml
  tsconfig.base.json
  .github/workflows/ci.yml

  docs/
    spec/
      wire-protocol.md      # the MCP profile + the alexia/* layer
      manifest.md           # plugin.json v1
      capabilities.md       # the capability name registry
      storage.md            # namespaces and the purge contract
      ui-schema.md          # the widgets, and what an eleventh had to argue
      skills.md             # the agentskills.io profile
      invariants.md         # the ten CI checks and what each one defends
    authoring/              # M3 — plugin author documentation
    cold-install.md         # the test protocol, and the results log

  packages/
    protocol/               # @alexia/protocol   Apache-2.0  types, schemas, versions
    sdk/                    # @alexia/sdk        Apache-2.0  what plugin authors import
    conformance/            # @alexia/conformance Apache-2.0 the suite a plugin must pass
    create-plugin/          # @alexia/create-plugin Apache-2.0 the scaffold command
    core/                   # @alexia/core       AGPL-3.0    supervisor, router, loop
    ui/                     # @alexia/ui         AGPL-3.0    chat shell, settings, library

  plugins/                  # every one of these is deletable
    hello/  crasher/  vanisher/          # M0 — the test plugins
    voice/                                # M2
    telegram/  computer/  memory/         # M4
    persona/  claude-code/                # M4
    media/                                # M4 — local image and audio generation

  registry/                 # M3 — Hono + D1, deployed separately
  spikes/                   # questions asked in code. Not shipped, not in the workspace
  src-tauri/                # M5 — Rust, and as little of it as possible
  test/
    cold-install/results.md # appended at every milestone, never edited
```

**Licence placement.** `LICENSE` at the root is AGPL-3.0. Each of `packages/protocol`,
`packages/sdk`, `packages/conformance` and `packages/create-plugin` carries its own
Apache-2.0 `LICENSE` and an SPDX header, and the README says in one line which applies where.
A plugin author must never have to wonder.

---

## The contract

The full text goes in `docs/spec/` (P0-3 through P0-5). This is the shape, so the specs are
transcription rather than invention.

### A plugin is an MCP server with a manifest

Core is an MCP **client**; each plugin process is an MCP **server**. Core spawns it,
`initialize`s it, and speaks the pinned MCP revision. Everything MCP defines is used as
defined — no reinterpretation, or the ecosystem benefit evaporates.

`plugin.json` sits next to the entry point, is read **before the process ever spawns**, and
carries everything core needs while the plugin is not running: what to show in the library,
what settings to render, what it requires, what it provides, what to purge.

```jsonc
{
  "manifest_version": 1,
  "id": "voice",
  "name": "Voice",
  "summary": "Talk to Alexia and hear it answer back.",
  "version": "0.1.0",
  "license": "Apache-2.0",

  "entry": { "run": "node", "args": ["index.js"] },

  // ours, not MCP's: which Alexia contract this was written against
  "alexia_protocol": 1,
  // MCP's own, pinned: which revision the server speaks
  "mcp_protocol": "2026-07-28",

  "requires": [
    { "cap": "audio.input",  "why": "to hear you speak" },
    { "cap": "fs.own_dir",   "why": "to store the speech model" },
    { "cap": "net.download", "why": "to fetch the model once, from huggingface.co" }
  ],
  "provides": ["voice.transcribe", "voice.speak"],

  "settings": [
    { "key": "model_size", "type": "choice", "label": "Speech model",
      "options": ["tiny", "base", "small"], "default": "base",
      "hint": "Bigger is more accurate and slower." }
  ],

  "storage": { "namespace": "voice", "tables": ["transcripts"], "dir": true },

  "commands": [ { "name": "mute", "summary": "Stop listening" } ],
  "skills": ["skills/dictating-well"],

  "min_tier": "T0"          // the cheapest rung this plugin's work is safe on
}
```

Tools are **not** in the manifest. They come from `tools/list` at runtime, because they can
change — that is what `notifications/tools/list_changed` is for, and it is what makes "a tool
can vanish mid-task" a protocol event rather than a crash.

### The `alexia/*` layer — everything MCP does not cover

Five methods. If a sixth is proposed, argue it against MCP first.

| Method | Direction | For |
|---|---|---|
| `alexia/settings/get` | plugin → core | read its own settings; core owns the values |
| `alexia/settings/changed` | core → plugin | notification, so a running plugin reacts to a settings edit |
| `alexia/storage/*` | plugin → core | namespaced reads and writes (below) |
| `alexia/capability/call` | plugin → core | call a capability another plugin provides, **by capability name** — the caller never learns which plugin answered, which is what rule 5 of the invariant actually means in code |
| `alexia/host/info` | plugin → core | platform, paths, the display name, the current privacy mode |

Everything else — tool calls, model calls, progress, cancellation, asking the user a
question, logging, folder scope — is MCP, unchanged.

### Storage, and the one piece of friction

Alexia.md confirmed: one SQLite file, a namespace per plugin, core owns the database, purge
drops the namespace. Honoured. The friction is that core must then *enforce* the namespace
without parsing arbitrary SQL.

**v1 answer:** a typed API over the tables declared in the manifest —
`insert` / `select` / `update` / `delete` / `count` against a declared table name, plus a
`kv` store for small values. Core creates them as `p_<namespace>_<table>`; purge is
`DROP TABLE p_<namespace>_*` plus the settings keys plus the plugin's directory. Nothing to
parse, nothing to get wrong, and the purge test can prove the absence of residue exactly.

There is a raw-SQL escape hatch, and it is deliberately conservative: core scans the
statement for identifiers and rejects anything it cannot prove is inside the plugin's
prefix. It refuses more than it needs to. **Logged as an open question** — see *New questions*
— because the first plugin that genuinely needs a join will tell us whether this is right.

### Versions: two of them, doing different jobs

- **`mcp_protocol`** — the upstream revision. Negotiated by `initialize`. Handled by the SDK.
- **`alexia_protocol`** — an integer, ours, bumped when *our* layer changes. Core compares it
  at load and refuses politely:

```
plugin says: alexia_protocol 1        core speaks 1..3   ->  loads
plugin says: alexia_protocol 4        core speaks 1..3   ->  does not load, and says
                                                             "Voice needs a newer Alexia"
```

Both checks happen before the plugin can do anything. This is what makes accepting
third-party plugins early survivable against a contract that is still moving — the property
Alexia.md identified as load-bearing, now with the exact mechanism attached.

### Permission modes, read off MCP annotations

| Alexia mode | What it does with a tool call |
|---|---|
| Ask me every time | every call waits |
| **Ask before anything risky** *(default)* | `readOnlyHint: true` → runs; anything else → waits |
| Watch and warn me | runs, checker reviews, flagged ones stop |
| Full trust | no prompts; the never-touch list still applies |

`destructiveHint: true` always gates, in every mode except Full trust. And per MCP's own
warning, **annotations from an unreviewed server are untrusted** — an MCP-compatibility-mode
server (M3-6) gets treated as if every tool were destructive until a human says otherwise.

---

## The ten invariant checks

These are the project. Alexia.md is explicit that with AI-written code nobody reads line by
line, the automated checks are what keep the thesis true. They live in
`packages/core/test/invariants/`, run in `pnpm check`, and run in CI on every commit.

| # | Check | Defends |
|---|---|---|
| 1 | **core-names-no-plugin** — grep `packages/core/src` for every directory name under `plugins/`, and for any import path containing `plugins/`. Plus a `dependency-cruiser` rule forbidding the edge. | Rule 1. The single most important check in the repo. |
| 2 | **boots-with-no-plugins** — a CI job that moves `plugins/` aside and runs core's entire test suite. | Rule 4. Not an aspiration; a job. |
| 3 | **crasher-contained** — `crasher` exits, hangs and leaks in turn; core stays up each time, backs off, and marks it unhealthy after three crashes in sixty seconds. | Process isolation is worth its memory cost. |
| 4 | **vanisher-replans** — a plugin's folder is deleted **mid-task**; the loop re-plans and the task completes. | Where the invariant and the agent loop meet. Alexia.md asks for this by name. |
| 5 | **purge-leaves-no-residue** — snapshot the DB and the filesystem, install → enable → use → delete, diff. The diff must be empty. | The transition Alexia.md says is worth testing hardest. |
| 6 | **no-node-apis-in-ui** — `packages/ui` may not import a Node builtin. | Keeps the Tauri port a port and not a rewrite. |
| 7 | **no-hardcoded-paths** — no `C:\`, no `/home/`, no literal separators in path construction. | Windows first, portable by discipline. |
| 8 | **no-overclaiming-strings** — every user-facing string is scanned for *"nothing leaves your computer"*, *"completely private"*, *"never leaves"* and their neighbours. | Alexia.md asks for this test by name. Local mode claims the model runs here, and nothing more. |
| 9 | **memory-budget** — core under 150 MB resident; an enabled-but-idle plugin runs **no process at all**. | Risk 2. If lazy spawn slips, isolation starts looking like a mistake for reasons that are really an unimplemented optimisation. |
| 10 | **rust-line-budget** — hand-written Rust in `src-tauri/` stays under ~300 lines, generated code excluded. | Alexia.md's own tripwire. Rust you cannot debug is worse than no Rust. |

Checks 1–5 land at M0. 6, 7, 8 and 10 land at P0-2 as trivially-passing rules that only ever
get harder to violate. 9 lands at M0-9.

---

## Phase 0 — Before any feature code

Roughly one week. None of it is optional and all of it gets more expensive later.

### P0-1 `[GATE]` Licences, README, repo public

The repo is private with zero commits and no licence. Alexia.md requires public from the
first commit and the licence set *before* the first push, because changing it later needs
every contributor's agreement.

- `LICENSE` (AGPL-3.0) at the root; `LICENSE` (Apache-2.0) in `packages/protocol`, `sdk`,
  `conformance`, `create-plugin`; SPDX headers; one line in the README saying which is which.
- README with a banner that cannot be missed: **the plugin contract is unstable and will
  break at M4.** Alexia.md is right that the first person who writes a plugin and gets broken
  by it is someone you would rather have kept.
- Move `Alexia.md`, `plan.md`, `questions.md` and `CLAUDE.md` into the first commit.

> **`[GATE]`: making the repo public and pushing are both irreversible-ish and outward-facing.
> Ask before either.**

**Done when** the repo is public, licensed, and `gh repo view` shows the licence.

### P0-2 Monorepo skeleton and CI

pnpm workspaces, `tsconfig.base.json` with project references, `vitest`, eslint,
`dependency-cruiser`, and `pnpm check` wired as `lint && typecheck && test && invariants`.
GitHub Actions runs it on push and PR, on `windows-latest` first (it is the target) with
`ubuntu-latest` alongside so portability breaks show up the day they happen.

Invariant checks 6, 7, 8 and 10 go in now, while they pass trivially.

**Done when** `pnpm check` is green locally and in CI on an empty repo.

### P0-3 Spec: the wire protocol

`docs/spec/wire-protocol.md`. Which MCP revision is pinned and why. Which MCP features are
used and how each maps to an Alexia concept (the table in *D50* is the skeleton). The five
`alexia/*` methods with request and response shapes. The two-version handshake and the exact
refusal message. **stdout is the wire — all logging goes to stderr**, stated where nobody can
miss it.

**Done when** someone could write a plugin in a language with no SDK using only this document.

### P0-4 Spec: `plugin.json` v1

`docs/spec/manifest.md` plus the zod schema in `packages/protocol`, with the JSON Schema
generated from it (`z.toJSONSchema`) so editors can validate a manifest as it is typed. Every
field, every constraint, a complete example, and the rules for `id` (lowercase, hyphens, must
match the folder name — mirroring agentskills.io so authors learn one rule, not two).

**Done when** the schema validates the voice manifest above and rejects six deliberate
mistakes.

### P0-5 Spec: capabilities, storage, UI schema, skills

Four short documents. `capabilities.md` is the registry of capability names and the rule for
adding one. `storage.md` is the namespace and purge contract, including exactly what a purge
removes. `ui-schema.md` is the ten widgets, with a rendered example of each. `skills.md` is
the agentskills.io profile: what Alexia supports, what it ignores, and how a bundled skill
differs from an installed one.

**Done when** all four exist and M0's code has nothing left to invent.

### P0-6 The invariant checklist and the cold-install protocol

`docs/spec/invariants.md` — the ten checks, what each defends, and how to run one alone.

`docs/cold-install.md` — the test protocol, and this matters more than it looks. Alexia.md
commits to sitting a real person in front of it at every milestone without helping. That
commitment survives only if it is an artifact:

- What to say to them ("nothing"), and what to do when they ask (say nothing).
- A stopwatch table: time to first screen, time per step, time to first reply.
- Every hesitation written down verbatim, in their words, not yours.
- Results appended to `test/cold-install/results.md`. **Appended — never edited.** The value
  is entirely in the trend across milestones.

**Done when** both documents exist and the results file has an empty table with headers.

---

## M0 — The skeleton that proves the thesis

2–4 weeks. No user-facing feature exists at the end of this and that is the point: the
riskiest assumption gets tested before anything is built on it.

### M0-1 `@alexia/protocol`

Types, the zod schemas from P0-4, the version constants (`ALEXIA_PROTOCOL = 1`,
`MCP_REVISION = "2026-07-28"`), the `alexia/*` method definitions, and the error codes.
Apache-2.0. **This package must never import from core.** `dependency-cruiser` enforces it.

**Done when** it builds standalone and core plus SDK both consume it.

### M0-2 The supervisor

The heart of M0.

- Spawn a plugin process with `execa`, wire stdio, attach an MCP `Client`.
- `initialize`, check both versions, refuse politely on mismatch with the exact spec'd
  message.
- `ping` heartbeat; unresponsive → kill and restart. **A hung plugin must never hang the chat.**
- Restart with exponential backoff. Three crashes in sixty seconds → unhealthy, stop looping,
  surface a *Restart* button.
- **Lazy spawn** — a process starts on first use, not at boot.
- **Idle shutdown** — no traffic for N minutes and it exits, respawning transparently.
- Route `sampling/createMessage` to the router (stubbed at M0), tagged with the plugin id for
  attribution.
- Serve `roots` from the folder scope (a fixed stub at M0).

**Done when** the crasher and vanisher tests (invariants 3 and 4) pass, and an idle plugin
shows zero processes in the OS process list.

### M0-3 `@alexia/sdk`

What a plugin author actually imports. Wraps `@modelcontextprotocol/server`, reads the
manifest, and hands back typed helpers for settings, storage, host capabilities and progress.
Its job is to make the correct thing the easy thing — especially **logging to stderr**, which
should be impossible to get wrong because the SDK's logger is the obvious one to reach for.

**Done when** `plugins/hello` is under forty lines because of it.

### M0-4 `plugins/hello`

A tool that answers. One setting, so the settings path is exercised. One row of storage, so
purge has something to remove.

### M0-5 `plugins/crasher`

Dies three ways on demand: clean exit mid-call, hang forever, allocate until the OS objects.
Each one must leave core standing.

### M0-6 `plugins/vanisher`

Its folder is deleted while a call against it is in flight. Core must notice, emit
`tools/list_changed` upward, and let the loop re-plan. At M0 the loop is a stub; the *event*
is what M0 proves.

### M0-7 Manifest loader and capability resolver

Scan `plugins/`, validate each manifest, build the capability map from `provides`, resolve
each `requires` against it. A plugin whose requirement nothing satisfies **loads and degrades
with the message its author wrote** — it does not crash and it does not silently vanish.
`alexia/capability/call` routes by capability name only.

**Done when** two plugins where one requires the other's capability work, and deleting the
provider leaves the consumer running and explaining itself.

### M0-8 The ten invariant checks

Checks 1–5 implemented and green. Check 1 is the one to write most carefully: it must catch
both the import and the bare string.

### M0-9 Memory budget harness

Measure core resident and per-plugin resident. Assert the numbers from invariant 9. Record
them in `docs/` so the trend is visible over milestones.

### M0-G — Done when

> **Delete a plugin folder while Alexia is running and nothing else notices.**

Plus: `pnpm check` green, the empty-`plugins/` CI job green, and the memory numbers inside
budget. **Stop here and report.**

---

## M1 — Core minimum

4–6 weeks. The biggest single chunk in the project.

### M1-1 Storage

`node:sqlite`, one file, in the platform's standard per-user application data directory —
never next to the executable, so an update or reinstall cannot take someone's history with
it. Forward-only migrations. Namespaced tables per the storage spec. A transaction helper,
since `node:sqlite` has none.

### M1-2 Sessions and history

Sessions, messages, and the step trace. Core owns all three. This is what makes "switching
models does not lose the conversation" true: models are stateless, the history is ours, each
request re-sends it to whichever model is now selected.

### M1-3 Settings and secrets

Settings store with per-plugin namespacing. `SecretStore` interface with the
`cross-keychain` implementation behind it. **An invariant test asserts no secret value ever
reaches the SQLite file.**

### M1-4 The provider layer

One OpenAI-compatible client. Chat completions, streaming, tool calls, usage accounting.
Providers are configuration — base URL, key reference, model list endpoint — not code.
Adding one should be a row, not a file. Alexia.md is explicit that this is the mitigation
keeping the provider-in-core exception bounded; skip it and core accretes a vendor
integration a month.

### M1-5 The model catalog

Fetch OpenRouter's `/api/v1/models`, cache to disk, poll daily, diff, and surface changes as
plain news: *three new free models are available.* Works offline from cache. Does not break
the day the endpoint changes shape.

Each entry carries: id, provider, tier (T0–T3), input and output price, context length,
`supports_tools`, modality, `nsfw_ok`, and **`trains_on_your_data`** (D51).

### M1-6 The free-tier pool

Alexia's own adapter, moved forward from *someday* because D51 makes it load-bearing.

- Provider table seeded from *Verified facts*, each with limits, base URL, terms URL and the
  trains-on-your-data flag.
- **Self-hosted only.** Keys and prompts never leave the machine. A hosted free proxy sees
  every prompt, and routing to one silently would be the same betrayal as violating a
  Local-mode pin.
- A persisted rate-limit ledger per provider (requests this minute, this day) so the router
  knows a tier is exhausted *before* it sends and gets a 429.
- Nothing is pooled without a key the user added themselves.
- **Provider terms checked and recorded** before this ships in a public release.

### M1-7 Ollama provider

T0. Model pull with progress — the first-run download in Local mode is this code path, so
build it as if the progress bar were the feature, because it is.

### M1-8 The router

Rules, not a classifier. Classify by request shape: short factual, formatting and
classification go low; tool-using multi-step goes middle; hard reasoning and code go high.
Plus the user override and the per-plugin `min_tier`.

Three axes — cost, privacy, content policy — each independently pinnable. Privacy is a
**placement policy per capability class** (text, image, speech, browsing), which is what makes
Combined mode *each job going to the side that is better at it* rather than a compromise.

Two behaviours that are not negotiable:

- **429 → next rung**, and when it escalates to something paid, one plain line so nobody is
  surprised by a charge.
- **Never silently violate a pin.** `/local` plus `/nsfw` with no suitable local model says
  *"no local uncensored model is installed — install one, or type `/cloud`"*. It does not
  quietly reach for a cloud model. A privacy pin that silently escalates is a betrayal, not
  a fallback.

Add the one-click **"try that again with a smarter model"** now. It is the right escape hatch
today and it quietly collects exactly the labelled data a cleverer router would need later.

### M1-9 Usage, attribution and caps

Spend per session, per model **and per plugin**. Monthly cap, warning threshold, optional
hard stop. Per-plugin attribution comes free because every `sampling/createMessage` is
already tagged with a plugin id at M0-2.

### M1-10 The chat shell

Web, no Node APIs (invariant 6). Streaming. Model indicator. Spend indicator. It gets wrapped
by Tauri at M5, not rewritten.

### M1-11 First-run flow v1

The pitch, in code, as early as it can exist. Steps 2, 3 and 4a of Alexia.md's five-step flow:
name, mode picker with **Combined preselected**, provider connect. No account, no tour, no
permission questions. The mode picker shows the honest trade for each — including, now,
whether the free models behind Combined train on your data.

### M1-12 Slash commands

Registered from manifests, so deleting a folder removes the command. First installed wins the
bare word; the second shows amber with one click to switch. Core derives `/plugin.command`
for every command always, so resolving a collision never breaks one that already worked.
Typing `/` lists everything with one-line descriptions. **Every command has a UI equivalent** —
commands are a shortcut for people who like them, never the only route.

### M1-D1 Holding theme — black, grey, and a face

*Inserted 2026-08-27 (D60), reduced the same day (D61).* D60's finding stands — the plan had
no design task, and M2-1 spends a theme that does not exist. The **sequencing** was wrong.
`docs/design.md` exists to be inherited by M2-1's ten widgets, so its real deadline is M2-1,
not the first cold-install test. The full pass moved to **M2-D1**. What stayed here is the
smallest thing that stops the shell looking unfinished, and two bugs found while doing it.

**What shipped:**

- **One dark palette, achromatic on purpose.** Black, greys, and near-white for the single
  bright role — what is yours, what is selected, what has focus. No hue, because a hue is a
  decision and this is a placeholder that says so in its own first comment. The light theme
  goes with M2-D1.
- **Her face.** `packages/ui/alexia.png`, 256 px grey, 31 KB: the tab icon, the mark beside
  the name in the header, and a larger one on first run. One drawing, three sizes. Core
  serves exactly one image, and `serve.ts` learned to hand back bytes rather than decoding a
  PNG as UTF-8 to run the token substitution over it — with a test, because that failure is
  a blank icon and nothing in the log.
- **A focus ring you can see.** Four lines, and it did not need a design system first.

**Two bugs, found by looking at it rather than reading it:**

1. **The composer was never hidden on first run.** `main.ts` has said `form.hidden = true`
   since M1-11 and it did nothing: `form { display: flex }` is a type selector, and it
   outranks the browser's own `[hidden] { display: none }`. So the first thing a new person
   saw was an *"Ask Alexia"* box that could not answer them — the shell was right and this
   stylesheet was overruling it. `[hidden]` now wins everywhere.
2. **The third mode card wrapped.** `#setup` was 44 rem and three `15 rem` cards need
   46.2 rem, so **Cloud** dropped to a second row and took the provider step under the fold.
   Widened to 50 rem, spacing tightened: the whole of first run now fits at 1280×800.

**Verified** in a headless browser at 1280×800, both screens, and `pnpm check` green.

**Deliberately not done — every line of it is M2-D1:** the type ramp, the spacing scale, the
colour roles written down, the light theme, `docs/design.md` itself, and the header hierarchy
that still renders a control, a status and a number as three identical badges.

### M1-I1 The crude installer

*Pulled forward from **M2-7** on 2026-08-28 (D65).* Built for M1-13, which was then waived
(D64) — so it is recorded on its own merits rather than on the gate's, because it is the
thing that makes M2-8 runnable at all.

It exists because of one sentence in `docs/cold-install.md` that was never going to be true:
*hand them a terminal command*. A machine that has never had Alexia on it has no Node, no
pnpm and no repo, so `pnpm start` there measures npm for twenty minutes and Alexia for none.
Alexia.md settled the principle already — *"a build that person can double-click has to exist
long before M5"*.

`pnpm package` → `dist-app/Alexia/`, a folder that runs on a Windows box with nothing
installed on it:

| | |
|---|---|
| `Alexia.cmd` | the double-click. `cd /d "%~dp0"`, so it runs from wherever it was unzipped |
| `node.exe` | the runtime, copied. 88 MB, which is most of what a tester downloads and the honest price of not asking them to install anything |
| `alexia.mjs` | core, esbuild-bundled to one file. **ESM out** — `serve.ts` reads `import.meta.dirname` to find the shell, and a CJS bundle would quietly destroy it |
| `keyring.win32-x64-msvc.node` | the one dependency a bundler can only leave alone. It is how a key reaches the Windows credential locker instead of the database, so it is not optional |
| `ui/` | the shell, in the folder `serve.ts`'s third path candidate looks in |
| `boot.mjs` | generated: start the server, print the address, then open a browser at it |

Not signed, not pretty, no auto-update. *Ugly is fine. Silent is not* — the window stays up,
says where she is, and says what to do if no browser came up on its own.

Data still goes to `%LOCALAPPDATA%\Alexia` and never beside the executable, which is what
makes *delete the folder* a clean uninstall of the program and not of the conversation.

**Verified** by loading the packaged bundle the way `boot.mjs` does, against an empty data
directory: the shell, stylesheet, script and image all served; `/api/state` 403 without the
token and 200 with it; `alexia.db` and `cache/models.json` created from nothing; the native
keyring loading out of the packaged folder; a clean close.

**What that smoke test found in core, and what was fixed with it.** The server read its
request target as `new URL(target, origin)`, which makes a leading `//` protocol-relative:
`//app.css` parsed as the *host* `app.css` at path `/`, so the shell answered for every path,
and a bare `//` had no host at all and came back a 500. The target is now pasted onto the
origin rather than resolved against it, so a path that is not a path is refused like anything
else that matches nothing. `serve.test.ts` holds it, over a raw `node:http` request — `fetch`
resolves its argument as a URL and so cannot ask this question.

**What M2-7 still owes:** a build that is not Windows-only, and whatever M2's plugin
lifecycle needs shipped alongside it. The double-click part is done.

### M1-13 `[GATE]` Cold-install test #1

The first real one. Follow `docs/cold-install.md` exactly. Do not help. Append to
`test/cold-install/results.md`.

Not because the product is ready — it is a dev build with no installer — but because *where
someone hesitates* is cheap information at M1 and expensive at M5.

**Sequencing, settled at D61.** The original argument for waiting on the design pass was that
a baseline set on a build you would not show anyone measures the look as much as the flow.
The counter-argument won: the most valuable finding available today — what a person does when
told to go and make an OpenRouter account — is not affected by any of it, and the full pass
is now M2-D1 regardless. M1-D1's holding theme is enough to run this on. Note in the results
what was and was not designed at the time, so the trend across the four tests stays readable.

**Before the test, two things fixed on the screen it measures.** Found by cold-starting the
build against an empty data directory and reading what came back — which is the last cheap
moment to do it, because after the test the rule is that you write it down and change nothing.

1. **The first sentence was not a sentence.** The name step read *"What should I call me?"*
   Alexia.md's first-run table gives step 2 as **"What should I call you?"** and that is now
   what the shell says. A baseline whose first hesitation is a typo measures the typo.
2. **The chosen name stopped at the header.** Renaming reached `.name` and nothing else, so
   the composer still said *"Ask Alexia"* — the one box a person who has just renamed her
   looks at. Alexia.md is explicit that the name is what they *"see everywhere"*; both now go
   through one function. Verified in headless Edge: name `Ada`, composer `Ask Ada`.

**Known and deliberate, and it belongs in the results rather than in the tester's column:**
first run is steps 2, 3 and **4a** only — M1-11 scoped it that way. There is no step 4b, so
**Local mode dead-ends**: `pull()` with progress exists in core from M1-7, but no shell spends
it. cold-install.md's five-minute Local budget cannot be met by this build and should not be
recorded as a failure of one. Combined is the path the test is for.

**Waived 2026-08-28 (D64) — not run, and the record says so.** Owner's call, to get on with
M2: the build cold-starts clean against an empty data directory and the two bugs above are
fixed, so the box is ticked and the half of this gate that needs a human — sit a tester down,
time them, do not help — moves to **M2-8**, where there is an installer and the clock can
start where `docs/cold-install.md` says it starts. Nothing was written into
`test/cold-install/results.md` to close this: that file carries a note saying test #1 did not
happen, and its first data row will be M2-8. What is lost is the M1 datum in a four-test
trend. What is kept is a results file nobody has to second-guess.

### M1-G — Done when

> **You hold a real conversation, routed to a free model, with spend showing 0.00.**

Plus: the router demonstrably falls back on a 429 rather than failing, and refuses to violate
a pin. **Stop here and report.**

**Ticked 2026-08-28 (D64), carried by M15-G rather than re-run.** M15-G is strictly more than
this gate asks for: a multi-step task on a free *local* model, every step visible, spend 0.00
because nothing left the machine. The two extra clauses are covered by
`packages/core/test/router.test.ts` — *"a rung that says 429 is the next rung's turn"* and
*"a pin is never violated quietly"* — both green in `pnpm check`. No separate M1-G session was
held, and the stop it asks for was spent on M15-G's report instead.

---

## M1.5 — The loop and its rails

*Inserted 2026-08-27 (D54).* Three to five weeks. This is the product, and it is where the
risk is: an agentic assistant with file permissions, built from code nobody read line by
line. The rails are not polish.

### M15-1 The agent loop

Plan → act → observe → repeat, with conversation and step history as state. Per-step model
tiering, because that is where most of the cost saving lives and it falls out of the router
already built.

### M15-2 Plugin tools reach the model

Aggregate `tools/list` across every enabled plugin, namespace them, hand them to the model.
`notifications/tools/list_changed` re-aggregates live.

**Tool descriptions are prompt text.** A vague description is a bug — it makes the model
reach for the wrong tool. This needs a real section in the author docs at M3, and it needs
saying here so the first-party plugins set the example.

### M15-3 Permission modes and the never-touch list

The four modes, driven off MCP annotations per *The contract*. Folder scope through an
ordinary folder browser, served to plugins as MCP `roots`; *Everywhere* exists and warns.

The **fixed never-touch list** ships with Alexia and is not editable: credential stores,
system directories, Alexia's own config. It is **not overridden by any mode, Full trust
included** — corrected here from *"except explicit Full trust"*, which contradicted both
Alexia.md's own mode table and wire-protocol.md §7 (D63). This list is deterministic code —
it is what stands between the user and a disaster when the checker is wrong, and a floor
with an off switch is not a floor.

**Spoken boundaries count as blocks.** *"Don't delete anything"* holds until lifted — a strong
default, not a hard guarantee, and the difference gets said out loud rather than implied.

### M15-4 The safety checker

A second model reviews an action before it runs. Local model by default; Claude Code when
connected and not the worker; a cloud model behind a blunt warning.

**Ask it closed questions.** A small local model cannot reliably answer *"is this a good
idea?"* It can answer *"does this command delete files that existed before this task started —
yes or no?"* Narrow closed questions are what small classifiers are good at. Open-ended
judgement is not. The checker adds coverage on top of the fixed rules; it never replaces them.

**Give up gracefully.** Three blocks in a row, or twenty in a session, and it stops
auto-approving and goes back to asking. A checker that keeps blocking does not understand the
task, and quietly retrying is worse than admitting it.

### M15-5 The visible trace and the stop control

Every step visible as it happens. **Not a spinner** — a spinner during a five-minute
autonomous run is how you lose someone's trust permanently.

The stop control works mid-step, always, including while a tool call is in flight. It is
`notifications/cancelled` plus a hard timeout, and it is tested as its own case.

### M15-6 Step-trace trimming

Recent steps verbatim; older ones collapse into a running summary; raw tool output dropped
once what was learned from it is recorded.

> Summarise for **what worked**, not only what happened. The trace is also the raw material
> for a learned skill at M4-5, and trimming for context and distilling for reuse want the
> same information. Getting this wrong here quietly caps how good learned skills can be.

### M15-7 Ceilings and the spend preview

A long leash — high ceilings, mostly runs free — chosen knowingly and logged as risk 4. Both
ceilings editable. **Show the cost before an expensive run**, once at the start, never per
step: *"This looks like about 12 steps, roughly $0.04. Continue?"*

### M15-8 A tool vanishes mid-task

Invariant 4, now with a real loop behind it. Delete a plugin folder mid-task; the loop
re-plans and finishes. This is exactly where the invariant and the agent loop meet, and it is
the test that proves both.

### M15-G — Done when

> **A multi-step task completes on a free model, every step visible, the stop button works
> mid-step, and deleting a plugin mid-task makes it re-plan rather than crash.**

**Reached 2026-08-27.** Run end to end against `qwen3:8b` on this machine — a real local
model, real plugins, nothing scripted:

| | Evidence |
|---|---|
| Multi-step on a free model | *"Greet Vaclav, then tell me how many people have been greeted"* → `hello__greet`, then `hello__greeted`, answered from both. **Spend $0.00.** |
| Every step visible | Each step emitted before its work, not after — the trace, not a spinner |
| Stop mid-step | Aborted 2 s into a 30 s call: the call came back `AbortError` and the task ended `stopped` at 24 s. `stop.test.ts` also covers the impolite case, where a plugin blocks its own event loop and only `callMs` ends it |
| A plugin deleted mid-task | Folder removed while the task ran; the model was told the tool no longer exists *and what does*, re-planned onto `hello__greet`, and finished — *"The slow tool wasn't available, so I skipped that step"* |

One honest note on the last row: in the live run the deletion landed just **before** the call
started, because the model took a few seconds to choose. The deletion landing *during* an
in-flight call is the deterministic case, and it is `replan.test.ts`.

Speed is the finding to carry forward: 44–49 seconds for two steps on an 8B. Correct, and
not fast. Nothing in M1.5 is wrong about it — it is the model, and Combined mode exists for
exactly this — but a person watching a local run needs the trace precisely because of it.

**Stop here and report.**

---

## M2 — Voice, the real proof

4–6 weeks. A plugin contract designed in the abstract always breaks on the first real plugin.
Voice is the right one because it exercises every hard mechanism at once — and because it is
the feature that got stuck in the Hermes codebase, which is why this project exists.

### M2-S1 Spike: Tauri tray, hotkey and overlay on Windows

**One day, and do it first.** Bare Tauri app: tray icon, global shortcut, an always-on-top
frameless window that shows on the hotkey and hides on blur. Cycle it fifty times.

Tauri v2 has open bugs where `alwaysOnTop` and the blur event stop working after a
`hide()`/`show()` round trip — which is the overlay's entire life cycle. If they bite, find
the workaround now. The primary local surface depends on this, and M5 is a terrible place to
discover it does not work.

**Done when** fifty show/hide cycles behave identically, or a workaround is written down.

**Answered 2026-08-28 (D66): the bug does not bite here, and no workaround is needed.**
`spikes/tauri-overlay/` — Tauri 2.11.5, `tauri-plugin-global-shortcut` 2.3.2, Windows 11
26200, WebView2 151. Fifty was the bar; **200 cycles** were run, and `results.md` is the
table. Every cycle: shown by `show()`, `WS_EX_TOPMOST` still set, focus taken, and hidden
again by nothing but the blur handler. Two consecutive 200-cycle runs, both clean.

Measured off the `HWND` rather than off `is_always_on_top()`, because the reported failure
*is* Tauri and the OS disagreeing — a framework that reports what it asked for cannot be the
witness to whether it got it. The tray and the hotkey are read the same way: each owns a
message-only window (`tray_icon_app`, `global_hotkey_app`), and `check-hotkey.ps1` drives the
whole manual half from outside the process — press `Ctrl+Alt+Space` with `keybd_event`, then
ask Win32. Hidden and topmost before, visible and topmost after, hidden again on blur.

**The one thing that did fail, and it is a finding about the product, not the spike.** At 200
cycles the first attempt diverged once, at cycle 33: the overlay was shown and was gone again
by the time it was measured, `WS_EX_TOPMOST` still set, exactly one blur counted. Nothing had
gone wrong with `alwaysOnTop`. **A blur event from the previous cycle arrived just after the
next `show()`, and the handler did what it is told to do.** The harness now waits out the
stragglers so a blur is counted against the cycle that caused it, and 200 of 200 pass.

That race is not an artifact of cycling fast. **M5-2 inherits it**: press the hotkey while a
blur is in flight — which is exactly what *click away, change your mind, press the hotkey*
looks like — and the overlay opens and shuts in the same breath. Blur-to-hide needs a guard
against a blur that predates the show it is about to cancel. Written down here because M5-2's
line is *"using whatever M2-S1 proved works"*, and this is the part it proved does not.

**Three smaller things, so M5-1 does not rediscover them:**

1. `tauri-build` **errors** on Windows without an `.ico` — it does not skip the resource, it
   fails the build. Her portrait is committed as both a 64×64 RGBA PNG (the tray, embedded
   with `include_bytes!`) and a 32bpp BMP-format `.ico` (the executable resource).
2. `tauri_plugin_global_shortcut::Error` has no `From` into `tauri::Error`, so a `register()`
   call cannot sit in a `tauri::Result` function. Box it.
3. Teardown prints `Failed to unregister class Chrome_WidgetWin_0. Error = 1412` on every
   exit. It is WebView2 noise after the work is done; noted so nobody reads it as a leak.

**Where it lives:** `spikes/`, not `src-tauri/`. This is a question asked in code — 174 lines
of Rust, more than invariant 10 allows the shipped app, which is the point of it being here
and not there. M5-1 writes the real shell from the finding, not by moving the file.

### M2-D1 The visual language

*Written 2026-08-27 as M1-D1 (D60); moved here the same day (D61) because this is where it is
spent.* M1-D1 left a holding theme — black, grey, a face and a focus ring. This is the pass
that makes it a language, and it runs **before M2-1**, not after: build the ten widgets first
and every plugin inherits an unstyled house style, for good.

M2-1 already promises it — *"Core renders; the plugin never draws. A plugin cannot style
itself wrong because it never styles itself"* — and Alexia.md sells it as *"every plugin
matches the theme and looks like it belongs."* Until this task there is no theme to match.

It is not decoration either. This product asks a person to paste an API key, hand over a
folder, and let something spend their money. The copy already earns that — *"not yet checked
— 7 of 7. Alexia will say so rather than guess"*, the spend on screen at all times, a
never-touch list nobody can edit. A careful sentence in a careless frame reads as a
prototype, and then the honesty is paying for the presentation instead of the other way
round.

**What is still wrong**, after M1-D1 took the two worst structural faults out:

| | |
|---|---|
| The header has no hierarchy | A control (mode), a status (model) and a number that matters (spend) are three identical badges |
| No scale | No type ramp, no spacing rhythm — `app.css` has good tokens and no opinion |
| One theme only | M1-D1 committed to dark. Light has to be real, not an inversion |
| First run is a section, not a view | It works and it fits, but it is still the chat page with a block swapped out |

**This is a restructure, not a recolour.** Move the markup. `index.html` is not fixed — if
first run wants to be its own view, make it one.

Every surface that exists: first run (the name, the three mode cards, provider connect); the
conversation and who said what; the composer and the `/` menu; the header; the empty, error
and `#note` states; and by now M15-5's step trace, which is the hardest thing on this list to
draw and the one people will look at most.

**The deliverable is a written language, not only a better screen.** `docs/design.md` — the
type ramp, the spacing scale, the colour roles, the states. That document is what M2-1's ten
widgets conform to and what M15-5's trace gets drawn against. Without it this is a repaint
that drifts back within two milestones, and drift is the named failure mode.

**Constraints that do not bend:**

- **Invariant 6** — `packages/ui` imports no Node builtin. It all has to live in a webview.
- **Invariant 8** — the honest strings are load-bearing. This pass may not soften, shorten or
  bury the training-data line, the spend, or any refusal. A sentence that is awkward because
  it is true stays awkward.
- One stylesheet, no framework, no bundler. *A chat window is not a build problem*, and every
  kilobyte here is one the Tauri shell carries at M5.
- Light and dark, both real.
- Every command keeps its UI equivalent (M1-12).
- Keyboard reachable throughout, focus always visible.

**Acceptance criteria:**

1. `pnpm check` green.
2. All three mode cards readable without scrolling at 1280×800 and above *(held from M1-D1 —
   this pass may not regress it)*.
3. First run and the composer are never on screen together *(held from M1-D1)*.
4. Every interactive element has a visible focus state; body text meets 4.5:1 in **both**
   themes.

**Done 2026-08-28 (D67).** `docs/design.md` is the deliverable — type ramp, spacing scale,
colour roles, shape, states, the hierarchy rule, every surface, and the anatomy the ten
widgets inherit. `app.css` is one implementation of it, rewritten from tokens: no size, space
or colour in that file is a literal any more.

**The four things that were wrong are fixed, and two of them were structural:**

| | |
|---|---|
| The header had no hierarchy | It has four kinds of thing now and they look like four kinds: identity, a **control** that looks pressable, a **status** with no box because there is nothing to press, and the **number that matters**, tabular, with `this month` beside it so it is never a bare figure |
| No scale | A type ramp of six and a spacing scale of seven, with one rule that outranks the numbers: the gap inside a group is always smaller than the gap around it |
| One theme only | Two, both built for their own ground rather than inverted, and **measured** — `packages/ui/test/contrast.test.ts` reads the declarations out of `app.css` and holds every text pair at 4.5:1 and every border and ring at 3:1. It also holds the two spellings of dark identical, because dark is written twice and two copies drift |
| First run was a section | It is a view. `data-view` on `<body>` swaps it, and on it **the composer is not rendered at all** — which is how criterion 3 stops being a rule somebody has to remember and starts being a fact about the DOM |

**The header is gone on first run too**, which was not on the list. With it present the mark
and the name were being drawn twice, sixty pixels apart, and a spend of `$0.00` beside a model
of *no model yet* is noise before there is either. A view that stands alone stands alone — and
removing it is also what bought the room for the whole of first run to fit at 1280×800.

**Verified, not eyeballed.** A scratchpad harness drives headless Edge over CDP with Node's
own `WebSocket` — no dependency — because setting `prefers-color-scheme` is the whole point:
*both themes are real* cannot be checked in a browser that will only ever show you one of them.
It reports:

- first run at 1280×800: **nothing scrolls**, three cards on one row, Start at 764 of 800
- first run and the composer are never both on screen, in either direction
- tabbed through with real key events: **10 of 10** focused elements show a ring, on both
  views — `#name → the mode radios → #provider → #key → #begin`, and in chat
  `Send → Stop → mode → permission → Allow → Not this time → the composer`
- screenshots of both views in both themes, and the permission prompt, read by eye afterwards
  for the things a measurement cannot see

**Two real bugs it caught, which is why the screenshots were worth taking:**

1. `input, select, textarea { width: 100% }` reached the **header's** two dropdowns and made
   each of them 1233px wide, pushing the model and the spend off the side of the screen. Width
   belongs to the container, not to the control. It is now a rule in `docs/design.md`.
2. The first-run question was set to `--text-lg` and then quietly un-set: `.field > .label`
   matches the same element, is equally specific, and comes later in the sheet.

**Still not done, deliberately:** `--text-xl` has no user yet — the empty and error states are
where it goes, and neither is designed. The ten widgets are M2-1; what exists here is the
shared anatomy they inherit (`.field`, `.hint`, `.error`, `.pill`, `.bar`), not the widgets.
5. No new dependency in `packages/ui`.
6. `docs/design.md` exists, and the shell demonstrably follows it.

**Out of scope:** the Tauri shell (M5-1). This task decides what the widgets inherit; M2-1
builds them.

**One copy question to settle while in there:** the shell asks *"What should I call me?"* and
M5-5's table says *"What should I call you?"*. Those are two different questions — one names
the assistant, one names the person — and the flow currently only asks the first. Deliberately
left alone at M1-D1: it is a product decision, not a typo.

### M2-1 Declarative UI schema v1

The ten widgets, **driven by what voice actually needs** rather than guesses. Core renders;
the plugin never draws. A plugin cannot style itself wrong because it never styles itself.

Settings must render while the plugin process is **not running** — lazy spawn means that is
the normal case. That is why the schema lives in the manifest.

**Done 2026-08-28 (D68).** `packages/core/src/settings.ts` turns a manifest into a pane and an
edit back into a checked value; `packages/ui/src/settings.ts` draws the ten; three endpoints
join them. Every widget conforms to `docs/design.md` and declares no styles of its own.

**It renders with nothing running, and that is asserted rather than hoped.** `GET
/api/plugins` reads manifests, the store and the keychain and spawns nothing — the test says
so, and a pane reports `running: false` because that is the ordinary state of a plugin under
lazy spawn.

**The sixth `alexia/*` method, argued and added.** `ui-schema.md` said a `status` is *"driven
by the plugin at runtime by writing to its own settings value"* — and **no method could write
one**. `alexia/settings/set` is it, and the narrowness is the design: **only your own `status`
keys**. A key you did not declare is `SETTING_UNKNOWN`; a `toggle` you did declare is
`INVALID_PARAMS`, with the reason. A plugin that could rewrite a toggle the user set could
quietly undo a person's decision, and would have to be trusted rather than read.

**What each of the ten does here:**

| | |
|---|---|
| `text`, `password`, `number`, `toggle` | the ordinary four. A number's range renders beside it when both bounds are declared |
| `choice` | two or three options is a segmented control, four or more a dropdown. **Core's decision, which is why an author does not get to pick** |
| `multi-choice` | checkboxes on one line |
| `path` | a typed path, checked against the disk by core — absolute, present, and the declared `kind`. The Browse button is disabled and says why: a native picker is the desktop app, at M5 |
| `status` | three states and no legend, and **`●` is not green** — see D67. Ready is the normal state of a working plugin; the one that needs looking at is the one already coloured |
| `progress` | fed by `notifications/progress` from the tool an `action` started, and **watched while the call is in flight**. A bar only ever seen at rest is a spinner with extra steps |
| `action` | a tool call like any other, so the permission gate is the same one: destructive is asked about in every mode except Full trust, and the question is put **beside the button**, where the thing being decided is |

**A password is never rendered.** The pane carries whether one is stored and the sentence
naming the real store on this platform — core writes that line, because a plugin promising the
wrong store would be lying on core's screen in core's voice. An empty value clears it: a
screen where a secret can be replaced but never removed keeps secrets somebody has decided to
stop trusting it with.

**Hello grew from two widgets to nine, and drives three of them.** It is the plugin that
proves the contract carries anything at all, so it is now also the reference for this screen:
a real `status` over the new method, a real `action`, and a real bar fed by a real tool. The
tenth, `path`, is not there because Hello has no honest use for one — the unit tests cover all
ten from a manifest that does.

**Three bugs found by building it, two of them nothing to do with M2-1:**

1. **No secret has ever been storable.** `cross-keychain` refuses an account name containing
   a slash, and `secrets.ts` built `<plugin>/<key>` — so **every keychain read and write threw,
   in both directions, on any real machine**, including the provider key somebody pastes at
   first run. Every test used `memorySecrets`, which has no such rule, and the first thing to
   touch the real store was this screen. Now `<plugin>.<key>`, with the account format pinned
   by a test, because the constraint lives outside this repo. See **D69**.
2. **A tool with no `inputSchema` is handed the context as its *first* argument.** Hello's new
   tool was written `(_args, ctx)` and got the context as `_args` and `undefined` as `ctx`, so
   `alexia.progress` threw and the bar never moved. In a plain-JavaScript plugin nothing types
   that for you, so the warning now lives in the SDK where the trap is.
3. **A redraw ate its own answer.** Pressing the button redrew the pane list from the response,
   which threw away the sentence it had just written into it — the one thing the person who
   pressed it is waiting to read. And redrawing on a settings edit takes focus off the control
   the keyboard is still on. Only `password` is redrawn now, because it is the only widget that
   genuinely looks different once it is set.

**Verified end to end** against the real loader and the real `plugins/` folder, in a headless
browser: three panes drawn with nothing spawned, the nine fields, a segmented control, a
toggle saved and read back through core, an out-of-range number refused with *"Warm-up time"
must be at most 5000*, and the action pressed — bar at 13%, status amber at *▲ Warming up*,
then hidden again at *● Warm* with the tool's own sentence beside the button.

**Left for their own tasks:** install, enable, disable and delete are **M2-5**, so the pane has
no Delete button yet; progress in the *chat* stream is **M2-6**; and `elicitation/create` — the
question a plugin asks at the moment it needs an answer — has no UI yet either.

### M2-2 Skills loader

agentskills.io, per P0-5. Scan skill folders, parse frontmatter with `gray-matter`, index
`name` + `description` only (~100 tokens each), load the body on match, load `references/` on
demand. A hundred installed skills cost nothing until one is relevant — which is what makes
an unbounded library practical rather than a context problem.

Two arrival routes: bundled with a plugin (installs and purges with it) or installed
standalone. Purge handles both; the marketplace never shows a bundled skill as independently
installable.

**Done 2026-08-28 (D70).** `packages/core/src/skills.ts` reads both routes, validates by
agentskills.io's own rules and hands the model an index. `packages/ui/src/settings.ts` shows
what loaded and what did not, on the screen that already existed for plugins.

**The index is a tool description, not a system line — and there is one `skill` tool, not one
per skill.** That decision is what made the rest small: `agent.ts` did not change at all, the
~100 tokens per skill land where a model actually looks when it is choosing what to reach
for, and levels 2 and 3 are the same call with a `file` argument instead of a second
mechanism. Nothing installed means no tool at all, because a tool that lists nothing is a
tool the model calls once to find out it was pointless.

**Every one of the three disclosure levels is real, and the middle one is where the saving
is.** The description of a skill is folded onto one line and the body is not in it — asserted,
because *the index is cheap* is the entire argument for adopting this format, and a loader
that quietly included the body would still pass every other test in the file.

**Reading a skill needs no permission, and that had to be said out loud.** A tool core knows
nothing about is not read-only until something says so — which is right — so `skill` declares
`readOnlyHint` through the same `about()` the gate already asks. Without it, the default mode
would ask the user for permission every time the model opened its own instructions. `about`
and `call` agree with `list` about whether the tool exists at all: a gate answering for a tool
nobody was offered is a gate answering for something that cannot happen.

**A broken folder is shown with the reason. Six ways to be broken, all of them visible:** no
readable `SKILL.md`, frontmatter that does not start at byte 0, no `name`, a `name` that is
not the folder name, no `description`, and — the one the spec did not name — two skills
answering to one name. The last is a `Problem` rather than a silent winner, because the model
cannot ask for either of them by name and the one it would get is whichever was scanned first.

**Two things fall out for free.** A bundled skill goes when its plugin does, through no code
of its own: there is no registry row and no cached index, so the next read simply finds one
folder fewer — the same mechanism as invariant 4, and what makes M2-5's purge a folder
removal rather than a cleanup. And nothing spawns: the bundled route joins the manifest to
`plugins.folder(id)`, so the list is right while every plugin is stopped.

`plugins/hello` now bundles `skills/greeting-well`, with a `references/` file, so both the
bundled route and level 3 are proved against a real plugin rather than a fixture.

**Verified end to end** in headless Edge against the real `serve`, the real plugins folder
and a real skills directory: two skills listed with the plugin one tagged *with hello*, the
broken folder named with its reason, nothing spawned, and no horizontal overflow at 1280×800.

**Left for their own tasks:** installing one is the skills marketplace (**M3-5**), which is
also what will call `invalidate()` — the user's own skills directory is not watched, so a
folder dropped in by hand is seen at the next restart or the next plugin change. Learned
skills are **M4-5**.

### M2-3 Voice — speech to text

`whisper.cpp` binary, spawned by the plugin process. **The plugin captures the microphone
itself and sends only text to core.** No audio crosses the boundary — that is the privacy
property process isolation was bought for, and it is the first time it is visible.

Model download over `notifications/progress`, because a 1.5 GB download with no feedback is
indistinguishable from a hang.

**Done 2026-08-28 (D71).** `plugins/voice` downloads a pinned whisper.cpp build and a model,
spawns `whisper-cli` on a file and `whisper-stream` on the microphone, and returns text.
Three tools: `transcribe`, `listen`, and `install` behind the settings screen's button.

**D59's runtime binding is real for the first time, and it was worth the design.** Before
anything is downloaded, `voice.transcribe` is declared in the manifest and **bound on no
tool** — a caller gets `-32050`, the same answer as *not installed*, which is what it can
actually plan around. The download finishes, `_meta` goes on, `tools/list_changed` fires, and
the capability answers. Verified in that order, against the real supervisor: refused, 1 726
progress frames, then `And so my fellow Americans…` returned by capability name with core
never learning who spoke.

**`listen` deliberately declares no `readOnlyHint`.** Reading a file somebody named is one
thing; opening the microphone is a thing a person wants to be asked about, and an undeclared
tool is one the gate stops on in every mode but Full trust. Read-only would have been true
about the disk and wrong about the room.

**The tenth widget is real.** M2-1 shipped `path` with no plugin that had an honest use for
one. `whisper_path` is that use — somebody with a CUDA build should not be made to download a
slower one — and it is also the entire non-Windows story, since only `win32-x64` has a
prebuilt CLI here.

**Four things found by building it:**

1. **`tar` on Windows is not necessarily Windows' tar.** `System32	ar.exe` is bsdtar and
   reads zip, which is why there is no zip parser in this repo. What is on `PATH` may be Git
   for Windows' GNU tar, which cannot read zip **and** reads a drive-lettered path as
   `host:path` — it failed trying to resolve a hostname one letter long. Named explicitly now.
2. **Every invariant check had been reading past every first-party plugin.** `shippedSource`
   matched `.ts` only, and the plugins are JavaScript — so the no-hardcoded-paths and
   no-overclaiming checks had never seen `plugins/hello/index.js`. Widened to `plugins/*/*.js`,
   and the first thing it caught was a sentence of mine in this very plugin: *the audio never
   leaves this process*. True, and still the kind of claim this project does not make. It now
   says what happens instead.
3. **`whisper-stream` has no `--no-timestamps`.** Its file-reading sibling takes `-nt`; it does
   not, so every line arrives wearing `[00:00:00.000 --> 00:00:04.000]`.
4. **Silence is not empty.** A pass over a quiet room comes back as `[BLANK_AUDIO]` or
   `[ Inaudible ]`, which handed on unedited is a model told that somebody said the words
   *blank audio* — and, worse, an end to the wait on the first noise in the room.

**Purge was measured, not assumed.** After a real download, Voice's own directory held 169 MB;
`purge` left the data directory at zero. That is invariant 5 against a plugin that actually
brings something heavy with it.

**What was verified with a microphone and what was not.** The capture path runs end to end:
SDL opens the default device at 16 kHz mono inside the plugin process, voice-activity passes
fire on real room audio, and what comes back over the wire is a string. A *scripted spoken
phrase* was not verified — playing audio through the speakers did not reach the microphone on
this machine, and nobody spoke into it. The recognition half is proved instead by the file
path, on a real recording. The parser between them — when to stop listening — is a unit test
rather than a room.

**Left for their own tasks:** `voice.speak` is **M2-4**; progress in the chat stream is
**M2-6**; and the hotkey that makes `listen` a product rather than a tool is **M5-2**.

### M2-4 Voice — text to speech

Piper by default; Kokoro as the quality upgrade. Registers `voice.speak`.

**Done 2026-08-28 (D72).** `voice.speak` is *text in, audio played, nothing out*, exactly as
`capabilities.md` defines it: Piper turns the sentence into a WAV inside the plugin process
and the operating system's own player plays it. No audio library and none wanted — a WAV file
and `SoundPlayer`, `afplay` or `aplay` is the whole of it, and a missing player fails with a
sentence naming it rather than with a dependency somebody has to build.

**The round trip is the verification.** Piper said *And so my fellow Americans, ask not what
your country can do for you*, and Whisper — through `voice.transcribe`, by capability name —
read back *and some of my fellow Americans, ask not what your country can do for you*. One
word off, from the `base` model's ear rather than from Piper's mouth. Two plugins' worth of
mechanism in one loop, and neither call named a plugin.

**Two downloads, two bindings, and they move independently.** Hearing and speaking are
separate files, so `voice.transcribe` and `voice.speak` bind separately — transcribing does
not fetch a voice and saying one sentence does not fetch a speech model. Only the button
fetches everything, because that is the one place somebody asked for all of it. The status
line says which half is ready, and `●` is reserved for both: a plugin that can hear and not
answer is halfway, and the person looking at that screen is the one deciding whether to wait.

**`speak` declares no `readOnlyHint` either**, for the same reason `listen` does not. Making a
noise in somebody's room is not read-only in any sense a person cares about.

**The shared half came out into `fetching.js`.** Whisper and Piper need the same four moves —
fetch a large file while saying how far along it is, unpack it, find what came out, spawn it —
and the second one arriving is what proved it was one thing rather than two similar things.

**Kokoro is not here, and that is a scope call rather than an oversight.** The parts list
offers it as the quality upgrade; taking it means an ONNX runtime and a phonemizer in this
plugin, which is precisely the dependency shape the whole thing has avoided — Piper ships
both of those inside its own 22 MB and asks nothing of the machine. The upgrade path that
costs nothing today is the voice choice: `amy`, `lessac` and `ryan`, one publisher, one
language, every one of them run. **A real Kokoro option belongs with local media generation
at M4-6**, where an ONNX runtime is already being paid for.

### M2-5 The full lifecycle

```
In library --install--> Installed --enable--> Enabled --disable--> Disabled --delete--> Purged
 nothing local          files on disk        process on         no process,        folder, tables,
                                             demand + tables    data kept          files all gone
```

Disable is reversible and cheap, so it is the default action in the UI and delete sits one
step further back. The install walkthrough shows permissions **in the author's own words** —
the `why` strings from the manifest, never capability identifiers.

Purge is the transition to test hardest (invariant 5). A plugin that leaves residue has
broken the invariant even though nothing visibly crashed.

**Done 2026-08-28 (D73).** The four arrows are real, persisted and on the screen.
`packages/core/test/lifecycle.test.ts` walks all of them; invariant 5 still owns the last one
and now proves the first two as well.

**The line that turned out to matter is between *installed* and *enabled*, and it is
consent.** A folder appearing in the extensions directory — put there by the library, by a
person, or by something neither of them noticed — **does not start running because it is
there**. That is a change of default: until now, loading a manifest was the whole of it. Now a
plugin arrives listed, described, and doing nothing, and the screen it arrives on is the
walkthrough: the summary, what it asked for **in its author's own words**, and one button.
Its settings are not drawn yet, because configuring something you have not agreed to run is
a screen asking two questions at once.

**Enable is the moment the namespace exists.** `store.create` moved out of `load` — an
installed-but-not-enabled plugin owns no tables, which is what makes the *Installed* box in
the diagram above literally true rather than a description of intent. A disabled plugin is
absent from `tools()`, from capability routing and from its own `action` button, and its
bundled skills wait with it.

**Disable keeps every last thing delete would take** — tables, rows, settings, its directory,
the 271 MB Voice spent twenty minutes downloading — which is the whole argument for it being
the action offered first. Delete sits behind a second press that has already said what goes.

**Install is a folder somebody points at**, validated where it stands and copied second, so a
folder that is not a plugin never lands in the directory core watches. Crude, and named as
such: browsing a library is **M3-2**, and until there is a registry there is nowhere else for
a plugin to come from. It is enough for M2-G's *install → talk → delete* to be something a
person does in the app rather than in Explorer.

**Yes survives a restart**, because it is a person's answer and not a fact about this process:
one `kv` row in core's namespace, read at construction. Purge takes it with the plugin, so
re-installing later starts at the walkthrough again rather than at a yes somebody gave to a
different copy.

**Four tests had to start saying yes**, and that is the check working rather than a cost:
`tooling`, `registry`, `replan`, `stop` and invariants 4 and 9 are all about plugins that
*run*, so they now enable them in one line — the same line the settings screen sends.
Invariant 5's comment had said *install and enable* while only ever installing; it now does
both, and asserts there is nothing in the database between them.

**Verified in headless Edge**: nothing installed, a path typed in, the walkthrough with six
permissions in Voice's own sentences, Enable, eight widgets, then Delete explaining itself
before it will do anything.

### M2-6 Streaming progress

`notifications/progress` end to end, from the plugin through core to a progress bar that
never goes silent. Silence is what kills a first run, not time.

**Done 2026-08-28 (D74).** M2-1 carried progress to the settings screen; this is the other
route — **through the agent loop**, which is where the work a person actually waits on
happens. A plugin's `notifications/progress` now reaches `Tooling.call`, becomes an
`AgentEvents.progress` on the running step, streams as its own frame, and moves a bar in the
trace row that is already on screen.

**One optional argument, and no new interface.** `Tooling.call` gained a fourth parameter; a
`Tooling` that ignores it — every fake in every test — is still one, because a function of
three parameters is assignable to one of four. That is the whole of the plumbing change, and
it is why nothing else had to move.

**The `progressToken` is created by asking for it.** `onprogress` is what puts one on the
MCP request, so a plugin that reports has somewhere to send it and a plugin that does not
never sends one. A caller must not have to tell *no progress* apart from *no tool*, and it
does not: the callback simply never fires.

**The bar appears when there is something to say and goes when the work does.** A bar always
present at zero is a bar nobody believes when it finally moves, and one left at 97% is worse
than none. A tool that reports only a message and no fraction gets its own words in the row
instead — both beat a row sitting still.

**Verified in the shell**, driving headless Edge against a scripted model that calls a
six-second tool: sampled every half second the row read 13, 25, 38, 50, 63, 75, 88 per cent
with *Warming up* beside it, then the bar gone and the tool's own sentence in its place. The
unit test asserts the ordering that makes it true — every report arrives strictly **between**
the step starting and the step finishing.

### M2-7 The crude installer

Not signed, not pretty, no auto-update. Something your test person can double-click.

It exists to answer one question at every milestone from here: **how long did that actually
take, and where did they stop?** The demo lives at M5 and M5 is last; without this, the claim
the whole product rests on cannot be measured until the end.

`@yao-pkg/pkg` for the core binary, a minimal Tauri wrapper or a plain NSIS script for the
double-click. Ugly is fine. Silent is not.

**Mostly delivered early, at M1-I1 (D65).** `pnpm package` already produces a double-clickable
Windows folder — bundled core, a copied `node.exe`, the shell and the one native dependency —
and it took neither `@yao-pkg/pkg` nor NSIS to do it. What is left here is the part M1 did not
need: the other platforms, and whatever M2-5's install/enable/disable lifecycle has to ship
beside it.

**Done 2026-08-28 (D75), and it earned its place by breaking.**

**Something to install.** The package now carries `plugins/hello` and `plugins/voice`, each
bundled the way core is and for the same reason — a plugin in this repo reaches its SDK
through a pnpm symlink into a store the tester's machine does not have. A folder holding a
manifest, one file and its skills is also what a registry download will look like at M3.
`crasher` and `vanisher` are not on that list and will not be: handing somebody a plugin
whose job is to die is not a demonstration.

**Three bugs, all in the same place, all silent, and only running it found them.** The
packaged build is the one artefact nothing else here exercises — a different module format, a
different resolver, a different folder layout — and **the packaged app had never once reached
the credential locker**:

1. `@napi-rs/keyring` opens with `createRequire(__filename)`. Free in CommonJS, **undefined in
   an ESM bundle** — so the import threw, `cross-keychain` read that as *this backend is not
   supported here*, and every secret fell to the PowerShell route.
2. That route's `credman.ps1` **was not shipped**, so behind the silent failure was nothing at
   all. The settings screen answered a stack trace.
3. `NAPI_RS_NATIVE_LIBRARY_PATH`, set by M1-I1's `boot.mjs` in good faith, is **checked first
   and broken upstream in 1.3.0** — the loader assigns what it loads to an inner variable and
   returns nothing, while its caller writes that return value over the same variable. Setting
   it did not merely fail; it took the branch that *does* work out of reach.

The fixes are one banner, one copied file and one deleted line. The native path is in use now,
proved by hiding `credman.ps1` and watching a real secret round-trip anyway.

**`pnpm package` now starts what it just built and asks it one question.** `/api/plugins`
reads manifests, the store and the keychain — the whole of what a fresh install touches before
anybody types anything — and the build fails if the answer is not JSON.

**The other platforms are answered with a decision rather than with code.** macOS and Linux
are three small changes away and the keyring's platform table already carries their slugs;
what stops it is that nobody has run one. `@napi-rs/keyring` reaches libsecret on Linux and
the Keychain on macOS, and *whether the app starts at all* is precisely what a packaged build
exists to answer — the three bugs above are what that question looks like when it is asked
honestly. The script fails loudly on an unsupported platform, which is the true state. The day
there is a machine to test on, this is a small commit.

**Verified**: the packaged folder, run with its own throwaway `%LOCALAPPDATA%`, installed
Hello from the folder it shipped with, showed it *not enabled*, enabled it, picked up its
bundled skill, stored and read back a real secret, ran its tool, and deleted it — leaving no
pane, no skill, no extensions folder, no data directory and no key in the locker, with the
folder it was installed from untouched.

### M2-8 `[GATE]` Cold-install test #2

**Deferred by the owner, 2026-08-28 (D79). Not passed.** The instruction was to build the
whole app and tune afterwards, so this box and M3-8, M5-6 and M3-G with it stay empty until
somebody has actually been sat in front of it. What was built instead is everything they
measure; what is missing is the measurement, and that is the one thing here worth being
pedantic about.

The first one with an installer. Time it. Compare against #1.

**This is now the first one, full stop (D64).** #1 was waived, so there is no baseline to
compare against — which makes M2-8 the row every later test is read against, and makes the
"what was and was not designed at the time" note in the results non-optional.

### M2-G — Done when

> **Install → talk → delete leaves no residue on disk and not one line changed in core.**

`git diff` across M2 shows zero changes under `packages/core/src` attributable to voice.
**Stop here and report.**

**Met 2026-08-28, pending M2-8.** Both halves, with the evidence.

**Not one line — and it is stronger than the wording asks for.** The two voice commits
(`1e891d8`, `e186cc7`) touch **no file under `packages/core/src` at all**. Not one attributable
to voice; not one, full stop. Everything core gained across M2 belongs to a task about core:
`settings.ts` and `host.ts`'s sixth method to M2-1, `skills.ts` to M2-2, the lifecycle in
`plugins.ts` to M2-5, progress in `agent.ts` and `tooling.ts` to M2-6. What voice touched
outside its own folder is three lines: an eslint global, a vitest include, and the invariant
globs it widened by being the first JavaScript plugin any check had read.

That matters because of *what* voice is. It downloads 240 MB, unpacks an archive, spawns two
binaries, opens the microphone, plays audio, provides two capabilities and binds each of them
only when its own files have arrived. Every hard mechanism this contract has, in one folder,
and core did not learn a single thing about it.

**Install → talk → delete, in the packaged app**, run with its own throwaway
`%LOCALAPPDATA%` so nothing could lean on a checkout:

| | |
|---|---|
| before | 4 files, 0 MB |
| install | from the folder the app shipped with — **not enabled**, and the six things it asks for shown in its author's own sentences |
| enable | tables created, tools listed, its bundled skill picked up |
| talk | its own Download button, pressed: 273 MB fetched **inside the packaged app**, in 35 seconds, ending at *● Ready — base, lessac* |
| delete | **0 MB.** Not a table, not a row, not a file, not a keychain entry |
| after | the only things on disk that were not there before are core's own: a `cache/models.json` and an empty `extensions/`. The folder it was installed from is untouched |

The *talk* half is proved twice more, at the level where the words actually are: through the
real supervisor, `voice.transcribe` returned *And so my fellow Americans…* from a real
recording, called **by capability name only**, with core never learning who answered; and
`voice.speak` said a sentence out loud that `voice.transcribe` then read back.

**What is left is M2-8**, which needs a person and a stopwatch.

---

## M3 — The plugin library

Registry, review, docs, conformance. Alexia.md's risk 5 is honest that this is where scope
grew; the ordering below reflects that the conformance suite is the load-bearing part.

### M3-1 Registry backend

**Built 2026-08-28.** `registry/` — Cloudflare Workers plus D1, seven routes, and no
framework: Hono was the plan and earns its place at about a dozen routes, not at seven. It
is deployed by a person (`wrangler d1 create`, `wrangler secret put ADMIN_TOKEN`,
`wrangler deploy`) and **has never been deployed**, which is why the client says *could not
reach the registry* rather than showing an empty list.

The half worth noticing is `/v0/revoked`. The listing simply stops showing a withdrawn
plugin, which is right for somebody browsing and useless to the person who already has it
on disk — so there is a second, never-cached route for exactly them, and publishing a fixed
version un-revokes the id so a withdrawal is not a death sentence.

Hono on Cloudflare Workers with D1. A read API over a table plus an admin path for you.

**No search ranking, no ratings, no download charts, no analytics.** Those are what turn a
registry into a product, and the brief is *a list with a revoke button*. The revoke button is
the reason a backend was chosen over a git-hosted index at all: submissions are accepted
early, so a malicious plugin has to be pullable *now*, not whenever clients next re-fetch.

### M3-2 Registry client and library UI

Browse, install with checksum verification, enable with the walkthrough, progress, disable,
delete. Never auto-enable.

### M3-3 The conformance suite

`@alexia/conformance`. **This must land before the registry opens.** It does the mechanical
half of review automatically — does the manifest validate, does it boot, does it handshake,
does it purge cleanly, does it degrade when a dependency is missing, does it log to stderr —
so your time goes only on the half that needs judgement. Without it, review becomes the
bottleneck that stops everything else.

It is also, per Alexia.md, the thing that says a plugin is correct without a human auditing
it. If time gets short later, **cut M4 to one plugin rather than cutting this.**

### M3-4 Author docs and the scaffold

`docs/authoring/` plus `npm create @alexia/plugin`. Contents: the manifest, the wire, the
lifecycle, storage, settings, capabilities, skills — and a real section on **writing tool
descriptions**, because they are prompt text and a vague one is a bug.

Say the two quiet parts out loud, in the docs, in the README: **the contract is unstable and
will break at M4**, and **there is no promised review turnaround.** *"Reviewed when I get to
it"* is honest and completely fine. A queue implying a turnaround you cannot meet is how solo
maintainers burn out, and it is much harder to walk back later than to state now.

### M3-5 The skills marketplace

Separate from the plugin marketplace, deliberately: text the model reads versus code that
runs on your machine, worst case bad advice versus anything the machine can do, light review
versus proper review. Keeping them apart makes the difference visible instead of something a
user infers from a badge — and lets the skills side move fast without dragging the plugin
side loose with it.

Cheaper to build: a signed JSON index over agentskills.io folders is enough here. The naming
has to carry the distinction, since some people will not know which one they need.

### M3-6 MCP compatibility mode

The payoff from D50. Add any MCP server as a tool source. Core synthesises a minimal manifest
— no settings, no storage, no capabilities — and marks it clearly: **"MCP server. Not an
Alexia plugin. Not reviewed by us."** Optionally federate the listing from
`registry.modelcontextprotocol.io/v0/servers`.

Per MCP's own guidance, annotations from an unreviewed server are untrusted: **every tool from
a compatibility-mode server is treated as destructive** until a human says otherwise.

### M3-7 Checksums and signing

Checksums verified on install; capability grants shown in plain words; never auto-enable.
Plugin signing where the registry can carry it.

### M3-8 `[GATE]` Cold-install test #3

### M3-G `[GATE]` — Done when

> **Someone who is not you builds a working plugin from the documentation alone.**

That person is the test. **Opening the registry to submissions is a separate `[GATE]`** and
requires the conformance suite green.

---

## M4 — Contract generality

The contract is *expected* to crack here. That is the entire point of doing it before anyone
else depends on it. M4 is heavy — if time gets short, cut it to Telegram plus computer
control and push the rest to backlog. Do not cut the conformance suite to fund it.

### M4-1 `plugins/telegram`

A credential, a long-lived connection, and messages arriving from **outside** rather than
core calling in. Owns storage (chat-to-session mappings), so it exercises purge.

grammY, long polling — no webhook, no port, no firewall dialog. Auth is a **one-time pairing
code shown in the desktop UI** that allowlists your Telegram user ID. No account system.

**The persistent marker is not optional.** Every Telegram conversation carries a visible mark
that it crossed Telegram's servers. Local mode means *the model runs on your machine* and
never claims more. Invariant 8 is watching the strings.

### M4-2 `plugins/computer` — computer control

The risky, heavily permissioned shape. The reason the permission model exists, and the only
way to find out whether the rails actually hold. Every tool it exposes carries honest
annotations, and the never-touch list gets its real test.

### M4-3 `plugins/memory`

Cross-session recall: what you said last month, your documents, embeddings. Owns its tables
and drops them on purge.

Deleting it makes Alexia forget you across sessions. It does not touch the conversation you
are having right now — which is the line a user would expect, and the reason history lives in
core.

### M4-4 `plugins/persona`

The personality node. Conversational output passes through it; **code, actions, permission
requests, alerts, and mode switches bypass it entirely.** That exclusion list is the good part
of the design: a permission prompt rewritten in a jaunty voice is a permission prompt someone
misreads. Personality changes phrasing, never facts — and the things where phrasing *is* the
fact are kept out of its reach.

Runs only for a non-default persona. Default Alexia streams normally with no extra call and
nobody pays for a feature they are not using. The pass runs on a small or local model, for
the same reason the checker does: rephrasing is a narrow closed task.

### M4-5 Learned skills

After a task **the model judges was non-trivial** — real problem-solving happened and it looks
likely to recur — offer: *"want me to remember how to do this?"* If yes, the episode goes to a
strong model that distils it into an agentskills.io skill.

This is the best answer in the whole document to founding goal 3. An agent figuring something
out is expensive; doing it a second time from scratch is waste.

> **The hard part, named honestly.** A trajectory is not a skill. It records what happened
> *once*, mixing transferable decisions with incidental detail, dead ends and mistakes. The
> distillation has to produce a *procedure*: what to do, when it applies, what to check along
> the way. That difficulty is the whole feature.

Distillation uses a strong model, and that is fine — it runs once, after a task that was
already expensive, and pays for itself on every reuse. Ask, do not assume.

**Attribution at the moment it fires** — *"using what I learned last time about sorting your
downloads"* — with *edit* and *forget* right there. A learned skill can be wrong; the user
finds out when it actually matters rather than in a settings list nobody opens.

### M4-6 Local media generation

ComfyUI headless, driven over its API. Without this, **Combined mode is Cloud mode with extra
words** — the local half of "cloud thinks, your machine makes the media" has to actually
exist. Note the SDXL VAE fp16 fix for 8 GB cards.

### M4-7 `plugins/claude-code`

Per D53: build it, ship it **disabled**, never auto-enable. Detect a missing `claude` binary
at enable time and say so plainly rather than failing on first use. The user runs
`claude setup-token` themselves. A plain-language notice at enable time. Written confirmation
from Anthropic sought before it is enabled in any public release.

### M4-8 Channels: formalise or do not

Alexia.md deferred this to n=3 deliberately: an abstraction invented at n=2 is usually wrong
in ways you only discover at n=3. **Revisit here, with evidence.** If a third surface exists
and has shown what the abstraction needs to cover, formalise `channel`. If not, do not — the
cost of waiting is a little duplicated plumbing; the cost of guessing wrong is a permanent tax
on every plugin.

### M4-9 Contract freeze v1

The contract broke during M4. Now freeze it. Bump `alexia_protocol`, publish a migration note,
and support one version back from here on.

### M4-G — Done when

> **Voice, Telegram and computer control all work with no special-casing anywhere in core.**

Invariant 1 is still green, which is the proof. **Stop here and report.**

**Met 2026-08-28.** Eight first-party plugins, and invariant 1 green — with two real catches
on the way, which is the check doing its job rather than passing quietly. `checker.ts` named
a plugin in a comment written before that plugin existed, and `serve.ts` came within one
character of naming another in a log tag. Neither would have broken anything today, and
both are exactly how the rule erodes.

The generality claim survived contact in the one place it should not have: `lifetime`
(D77). Everything else about Telegram — a credential, a long-lived connection, messages
arriving from outside, its own storage — needed nothing from core that voice had not
already needed. Computer control needed nothing at all: the permission model read its
annotations and asked, which is what it was built for.

---

## M5 — The app

The demo, finally shipped. Everything before this has been measuring the claim; this is where
it becomes true.

### M5-1 The Tauri shell

**Built 2026-08-28 (D80).** 135 lines of Rust against the 300-line budget. `pnpm sidecar`
arranges the packaged build the way Tauri looks for it and `pnpm tauri build` produces
`Alexia_0.1.0_x64-setup.exe`. Run and verified: the real shell served, the token injected,
every module 200, core resident at 65 MB.

**Node SEA was re-evaluated here, as this task asked, and rejected.** It would be one
signable artefact instead of an executable plus a script, which genuinely matters at M5-3 —
but it cannot load a native addon from a snapshot, and `@napi-rs/keyring` is how a key
reaches the Windows credential locker rather than something worse. Trading a real property
for a tidier artefact count is the wrong way round.

Wrap the M1-10 chat shell. Core ships as a sidecar binary. **Re-evaluate Node SEA against
`pkg` here** — by M5 the Node version has likely moved and SEA is the cleaner artifact to sign.

**Keep the Rust boring.** It is in this project for four things: the installer, signed
auto-updates, the tray icon, the global hotkey. Tauri ships official plugins for all four,
configured mostly from TypeScript. If you are about to write Rust business logic, stop — it
belongs in core behind the RPC boundary. Invariant 10 is the tripwire.

### M5-2 Tray, hotkey, overlay, autostart

Using whatever M2-S1 proved works. `tauri-plugin-global-shortcut`, `single-instance`,
`autostart`, `positioner`.

Alexia is a **tray-resident daemon with thin UI faces**, not an app you launch. So:

- Autostart on login, with an obvious way to turn it off.
- **"Is it running?" answerable at a glance.** The tray icon is the only answer the target
  user has, so its four states — idle, working, needs you, error — matter more than usual.
- **Dismissing the overlay never cancels a running task**, and a task that finishes while the
  overlay is closed needs a way to get your attention.
- Never in the taskbar. Escape dismisses.

### M5-3 `[GATE]` The signed installer

SignPath Foundation: apply, wire the GitHub Actions integration, sign the release. Windows
first; macOS and Linux follow as a port, not a rewrite.

The publisher will read *SignPath Foundation*, and an OV certificate still meets SmartScreen
until reputation accumulates. **Say that in the release notes** rather than being surprised by
it — and remember that a SmartScreen warning in front of a non-technical user is precisely
where setup dies.

> `[GATE]`: applying to a foundation and publishing a signed binary are outward-facing. Ask.

### M5-4 Automatic updates

`tauri-plugin-updater`. Two update paths that share most of their code: first-party plugins
ride along with the app; third-party plugins update independently with a protocol version
check. The only real difference is where the version list comes from.

### M5-5 First run, final

All five steps, polished:

| # | Screen | Time |
|---|---|---|
| 1 | Double-click the signed installer | — |
| 2 | *"What should I call you?"* — prefilled `Alexia`, skippable, one field | 5s |
| 3 | *"How should I run?"* — Local (~5 min) / **Combined (preselected, ~2 min)** / Cloud | 15s |
| 4a | Combined or Cloud: connect a provider — OpenRouter's free tier needs no card | 60s |
| 4b | Local: model download, progress that never goes silent | ~3 min |
| 5 | First conversation. Tray icon appears, hotkey shown once. | — |

**Steps 1–3, 4a and 5 come in under two minutes.** 4b is the only step that ever pushes past
it, and only in Local mode, never as a surprise mid-story.

No account, no email, no sign-up — Alexia has no user backend at all. No onboarding tour. No
permission questions: the mode defaults to *Ask before anything risky*, and folder access is
requested the first time something needs it, the way a phone app does. Asking someone which
folders an assistant may read, before they have given it a single task, is a question with no
meaning yet.

### M5-6 `[GATE]` Cold-install test #4 — the real one

Signed installer, clean machine, stopwatch, no helping. This is the claim the entire product
is built on, finally measurable.

### M5-G `[GATE]` — Done when

> **A non-technical tester installs it cold and reaches a working conversation without ever
> seeing a terminal.**

Under two minutes in Combined mode, or you know exactly which step broke the claim and by how
much.

**Not met, and deliberately not ticked (D79).** Everything the sentence describes now exists
— an installer that builds, a first run with all five steps on screen, a tray icon and a
hotkey, no terminal anywhere in the path. What does not exist is a tester. The claim is the
one this whole document is built on, and it is measured by a person or it is not measured.

---

## M6 — The control surface

*Inserted 2026-08-29 (D81–D84). The evidence is a working predecessor rather than a guess:
`alexia control` — the Python dashboard from the first Alexia, still running on this machine
on `127.0.0.1:8771` — shipped nine panels over 237 commits and found out which ones a person
actually opens. This milestone is that surface rebuilt on this contract, and the parts of it
that were wrong here are named as loudly as the parts that were right.*

**What the chat window cannot answer.** M1-10 gave Alexia one screen and M2-1 gave it a
settings pane, and between them they answer *talk to it* and *configure one plugin*. Neither
answers the questions that arrive on day thirty: **what has this thing been doing, what did I
say yes to, what does it know, and which of these did I install?** Those are not settings. A
setting is a value you change; these are records you read, and a screen that renders them is a
different screen.

### What the old dashboard used for what

Read before writing any of the tasks below. The left column is what was actually built and
lived with; the right is where it lands here, and **four of the seven do not belong to core at
all** — which is the whole reason this milestone is shaped the way it is.

| Old panel | What it read | Where it lands here | Owner |
|---|---|---|---|
| **Skills** | `SKILL.md` files the gateway scans, plus two sidecar records — provenance and pending-review | `skills.ts` (M2-2), the marketplace (M3-5) | **core** |
| **Workflows** | `workflow_defs/*.json`; *"mirrors SkillsTab's own shape, since the lifecycle is identical by design"* | `learned.ts` (M4-5) — this project's word for the same thing is a **learned skill** | **core** |
| **Tools** | `cli-hub list --json`, grouped by category, filtered client-side, read-only | `tooling.ts` — the tools plugins put in front of the model | **core** |
| **Live Trace** | `trace_events.jsonl`, polled, grouped into runs, last five kept | the agent loop's own step events (M15-5, D74) | **core** |
| **Memory Graph** | an Obsidian-style vault — notes, `[[wikilinks]]`, backlinks — drawn as a force graph | `plugins/memory` (M4-3) | **a plugin** |
| **Voice** | upload a 15-second clip and a transcript, build a clone, pick which voice speaks | `plugins/voice` (M2-3, M2-4) | **a plugin** |
| **Commitments** | `identity/commitments.jsonl`, the accountability ledger, read-only | **nothing yet** — see M6-8 | **a plugin that does not exist** |

Two more were built there and are deliberately not rebuilt: **MCP Servers** is already M3-6's
screen, and **Proactive** and the **mode badge** are `plugins/persona`'s business if they are
anyone's.

**The mistake worth not repeating.** All nine of those tabs were listed by hand in one
`App.tsx`, and one of them — a 480-line panel for a single text-to-speech vendor — sat in the
dashboard's own source tree. That is the monolith this project exists because of, arriving by
the back door: not a feature you cannot remove, but a feature core cannot stop naming. **The
tab list here is generated** (M6-2), and the three plugin-owned panels above are the proof.

### What came across unchanged

Three things the old dashboard got right on the first try, taken as they stand:

- **Read-only unless this screen is the only owner.** Two of its panels open with the same
  sentence — read-only *deliberately*, because the CLI already owns the write path and a
  second one would be a parallel mechanism. It is a good rule and it holds here.
- **Poll, never watch.** Written into the trace backend as a rule with a `grep` line proving
  no filesystem watcher anywhere in the file. The vault changed every ten minutes; a watcher
  would have been complexity bought for nothing.
- **A missing module must not stop the app, and must not print a plausible-looking success
  either.** Routers mounted lazily, each in its own `try`. The same shape core already uses
  for a plugin that fails to load.

---

### M6-1 The route guard, and the check that keeps it

**Built 2026-08-29 (D82, D85).** `packages/core/src/guard.ts` classifies all seventeen paths
`serve.ts` answers — three read-only, eleven reversible with a reason each, three guarded —
and `refuse()` runs **before dispatch**, so a confirm is not something a handler has to
remember to ask for and a route nobody has classified is refused rather than run. The body is
read and parsed once at the top for the same reason, which also turned malformed JSON from
twelve independent 500s into one refusal. `guard.test.ts` walks the real routes out of the
source in both directions — a route missing from the table and a table entry that is no
longer a route are both red — and then makes the same requests over a live server, walking
the guarded list rather than a copy of it. Verified going red by adding an unclassified
`POST` handler and watching it fail by name. Writing the reasons is what found D85.

**Every state-changing route is either guarded or declared safe with a written reason, and a
test proves there is no third category.** Guarded means it refuses without an explicit
`confirm`; declared safe means it is in a list, with a comment saying why it is reversible.

`serve.ts` has twelve `POST` handlers today — install, enable, disable, purge, settings,
ceilings, permissions, actions, learn, servers, setup, stop — and **no rule at all** about
which of them can destroy something. The predecessor had exactly this problem, solved it, and
left a note about the hole in its own solution:

> `SAFE_STATE_CHANGES` is keyed by `(path, method)` **globally across every mounted router**
> … `/{name}/approve` was declared safe for the skills router, where it only un-archives; the
> MCP router's own `/{name}/approve` writes into the live gateway config and would be silently
> waved through.

Found, written down, not fixed. **It cannot reproduce in the same shape here** — core's router
is one flat match on `url.pathname`, so a path is already globally unique — and that is worth
saying out loud rather than discovering later if the router is ever split.

- The declared-safe list carries a **reason per entry**, not just a path. An entry nobody can
  justify in a sentence is an entry that should have been guarded.
- The test walks **the real routes**, not a list copied beside them, so a route added tomorrow
  is covered without anybody remembering this file exists.
- **Not an eleventh invariant.** The ten are about the plugin contract — what survives a folder
  being deleted. This is a safety property of core's own HTTP surface, so it joins `pnpm check`
  on its own merits and the ten stay ten.

### M6-2 The control view, and a tab list nobody writes by hand

**Built 2026-08-29 (D86).** A fourth `data-view`, reached from the header, whose tab strip is
whatever `/api/panels` returns — core's four, then one per enabled plugin that declared a
`panel`. `panel` is a manifest field, so it cost a contract revision: **`alexia_protocol` 3**,
`MIN` raised to 2 with it, which is the *one revision back* promise being kept for the first
time rather than described. The widget renderer moved to `packages/ui/src/widgets.ts` and
both screens use it — one renderer, because two would drift on the day one was fixed — and
`settings` and `panel.widgets` became one namespace, since a widget's value is stored once.
**Invariant 1 now reads `packages/ui` as well**, joined while it still passed trivially,
which is what makes M6-G's *no file in core or the shell contains the plugin's name* a check
rather than a hope. Core's four tabs carry a sentence each saying what they will hold and
which task builds it; M6-4 and M6-5 delete them. Verified running: the strip drawn, a
declared panel appearing on enable, a panel widget writing to the same store the settings
pane writes to, and the tab gone the moment the folder was.

A fourth `data-view`, beside first-run, chat and settings, reached from the header. The
mechanism exists already (D67) and nothing about the chat window changes.

**The tab list is assembled, never typed.** Core contributes the tabs whose data core owns —
Activity, Skills, Tools, Library. Every other tab comes from a plugin that declared a `panel`
in its manifest, the same way it declares settings, and it appears because the plugin is
installed and enabled and for no other reason.

> **The rule is M0's rule, one screen later.** If you are about to type `memory` inside
> `packages/ui`, you have found a missing capability, not a shortcut. Deleting a plugin folder
> takes its tab with it, and core never knew the tab's name.

- A panel renders **while the plugin is not running**, for the same reason settings do — lazy
  spawn makes not-running the ordinary case. Anything that needs the process is a tool call the
  panel makes when someone opens it, not a spawn at draw time.
- Enabled but not running is a **normal** state and reads as one; installed but not enabled has
  no tab at all, because a folder appearing is not consent (D73).
- **Narrow is a real case.** The old dashboard learned it the hard way: nine tabs in a
  scrollable row was technically fine and awkward in practice, and the fix its owner asked for
  was to tap the active tab's own name and get a list. The overlay is narrower than any phone
  this was tested on, so the same treatment applies here at the same breakpoint.

### M6-3 `table` — the eleventh widget, and the conversation the spec asked for

**Built 2026-08-29 (D83).** Granted, and it kept the promises that made granting it cheap. A
row action **is** an `action`: the same lookup, the same `rule()`, the same two steps — the
only difference is that it carries the row it is about and the question appears beside that
row. Rows arrive over MCP's own `structuredContent`, shaped `{ rows: [...] }` with a string
`id` on each, because the protocol already has an envelope and Alexia adds none of its own.
**It is the one widget that needs the process**, which is exactly the shape M6-2 asked for:
the panel draws from the manifest while the plugin is stopped, and asks for its contents when
somebody opens it. `/api/rows` and `/api/detail` go through the same gate as everything else,
so a `rows` tool that has not declared itself read-only is asked about rather than quietly
run. Three author mistakes get three sentences rather than an empty list: no
`structuredContent`, a row with no `id` — named by row number — and a table nobody declared.
The one refactor it forced was worth it on its own: **the permission ruling is now written
once** in `serve.ts` and used by four callers, the copy made for `/api/command` having
already begun to drift from the one it was copied from.


`ui-schema.md` says an eleventh widget *"is a conversation — open an issue saying what the
tenth could not do."* This is that conversation, held properly rather than skipped.

**What the ten cannot do: a list of things with actions on each one.** Four of the seven panels
above are the same object — rows, a few columns, a button or two per row, a filter, sometimes an
expandable detail. The old dashboard wrote that object four times, and its own comment on the
second one says so: *"mirrors SkillsTab.tsx's own shape, since the lifecycle is identical by
design."* Four independent hand-written copies of one shape is the strongest argument for a
widget this schema will ever get.

```jsonc
{ "key": "installed", "type": "table", "label": "Installed",
  "rows": "list_things",                       // a tool call, or a core source
  "columns": [
    { "key": "name",  "label": "Name" },
    { "key": "uses",  "label": "Uses", "align": "right", "hideNarrow": true }
  ],
  "rowActions": [{ "key": "remove", "label": "Remove", "tool": "remove_thing",
                   "confirm": "Remove {name}?" }],
  "detail": "explain_thing",                   // optional, expands under the row
  "filter": true,                              // client-side, over declared columns
  "groupBy": "category" }
```

- **A row action is an `action`.** It goes through the permission gate M2-1 already built, and
  the question appears beside the row, where the thing being decided is. No second gate, no new
  concept.
- **`confirm` is the destructive half of M6-1**, on the same screen: a second press that has
  already said what goes. The old dashboard's Delete → Confirm delete, which is a good pattern
  because the first press costs nothing and the second one is unambiguous.
- **Columns declare their own narrow behaviour.** Seven columns on a 375px screen forced
  sideways scrolling to reach the Delete button — usable in the sense that the scroll stayed
  inside the table, and not usable at all in the sense that matters.

**Two more widgets are wanted and neither is granted here.** Both have exactly one user, which
is this schema's own bar for saying no:

| Wanted | Only user | Verdict |
|---|---|---|
| `file` | voice, for a 15-second clip | **Decide at M6-6, with voice as the evidence** — the same method M2-1 used. There is genuinely no way to express *give me an audio file* in the ten, which is a stronger argument than "it would be convenient" |
| `graph` | memory, for a note graph | **Decide at M6-7.** This is Backlog item 4's exact case, and the memory panel ships as a `table` first so the question is answered by something already working |

### M6-4 Skills, learned skills and tools — three panels, one widget

**Built 2026-08-29 (D87).** Four tables, one widget, and **not one line of bespoke rendering
in the shell** — `control.ts` draws a core tab and a plugin's through the same function, and
the only difference between them is whose name goes on the requests the widgets make. That
was the test this task existed to run, and `table` passed it. Core's tables are declared in
`panels.ts` exactly the way a plugin declares one, and `surface.ts` is four functions
returning rows plus one that acts on a row. The Tools column that earns its place is **what
the permission gate will do with each tool** — read from the same annotations `rule()` reads,
with silence reported as silence. Broken folders are rows with reasons rather than absences,
on both the skills list and the library one. And the one write path on the whole screen is
*forget a skill*, guarded by M6-1 because core acting on core's own data has no `rule()` in
front of it; a bundled skill is refused with the sentence rather than having no button, since
a missing button answers nothing.

**Edit did not survive, and that is the finding** (D87). It is bespoke rendering — a textarea
is not one of the eleven — and this task was written to notice exactly that. Editing a learned
skill stays where M4-5 put it: beside the attribution line at the moment it fires, which is
also the moment a person can see what it did. The panel says what a skill was learned from
instead, which is the question a week later, and `learned_from` is now written into the skill
at distil time because nothing else could answer it.


If M6-3 is right, these three are configuration. If any of them needs a line of bespoke
rendering, M6-3 is wrong and this is where that shows up — which is why they are one task and
not three.

- **Skills** — every installed skill, where it came from, whether it is enabled, and the six
  ways it can be broken that M2-2 already names. Delete behind a confirm. A skill bundled with a
  plugin says so and has no separate delete, because it goes when the plugin does.
- **Learned skills** — the same table, plus what distinguishes them: **the task they were
  learned from**, and *edit* and *forget* on the row. M4-5 already commits to attribution at
  fire time; this is the same information at rest, and the place where a learned skill that
  turned out to be wrong gets removed by somebody who noticed a week later.
- **Tools** — read-only, grouped, filtered. Every tool every enabled plugin puts in front of
  the model, which is the only screen in the product that answers *what can it actually do
  right now*. Read-only because `tooling.ts` reads the plugins and the plugins are the write
  path; a second one here would be a parallel mechanism.

### M6-5 The trace, with a memory

**Built 2026-08-29 (D88).** `trace.ts` is a second consumer of the same stream the screen
already reads, and it keeps what the loop **did** rather than what the model was **shown** —
the two are different by M15-6's design, and trimming this one because the context was
trimmed would have been one decision serving two jobs badly. Five runs, in memory, gone on
restart, with the predecessor's reason kept intact. All four small things came across:
`backtrack` marks a step that began while the one before it was in error, and it is three
lines that turn a flat list into an agent visibly recovering; asked-for and answering model
are two labels, said out loud only when they differ, because the 429 fallback is invisible
everywhere else; the export is one run as text, written to a file, because *send it to
somebody* is the sentence it exists for; and the detail on screen is the same text the export
writes, so what a person reads is exactly what they send on. The one new event on the loop is
`turn`, carrying both model names — the router's plan already knew both, and nothing had ever
asked it.

**Exporting is the guard's first declared-safe core action.** It adds a file and takes
nothing away, so the allow-list in `guard.ts` names it — and everything of core's *not* on
that list still needs a confirm, which is the right way round for the next one.


The trace exists (M15-5) and streams (D74), and it is **gone the moment the task is** — which
makes it a progress indicator rather than a record. The panel is the record, and it is the
same event stream read by a second consumer.

> **Two consumers, one stream, and do not conflate them.** M15-6 trims the trace *for the
> model's context* — old steps collapse, raw tool output is dropped once what was learned from
> it is recorded. The panel is for a person looking at what happened, and wants the untrimmed
> version. Trimming the panel because the context was trimmed would be one decision serving
> two jobs badly.

Four things come straight across from the predecessor, three of them small:

- **`backtrack`** — a step that begins while the one before it is in error is a retry, and
  saying so turns a flat list into an agent visibly recovering. Three lines, and it is the
  difference between a log and a story.
- **Asked-for model and answering model are two labels.** They differ, and here they differ for
  a reason core creates: the router falls back on a 429 (M1-8). The header badge shows one
  model; the trace should show both when they are not the same, or the fallback is invisible
  in the one place it is explicable.
- **Last five runs, in memory, gone on restart** — with its reason kept: *restarting and finding
  an empty history is the honest behaviour for something that was never meant to be a permanent
  log.* A person who wants one exports it.
- **Export one run**, because the second thing anybody does with a bad run is send it to
  somebody.

### M6-6 `plugins/voice` declares a panel — and the `file` question

**Built 2026-08-29 (D89). `file` is refused, and the evidence is why.** The panel ships: a
`table` of every voice this machine has, with *Speak in this* and *Remove* on the rows, and
a `path` plus an `action` for bringing your own. It is the first tab core has never heard the
name of, and core still has not — `panels.ts` does not contain the word.

**The clip that motivated `file` is not a thing voice can do.** The predecessor's owner asked
for *load 15 seconds of a voice and text*, and that was a cloning feature of a text-to-speech
vendor this project deliberately did not take (M2-4, D72): **Piper does not clone from a
recording.** What a person can genuinely do is bring a Piper voice they have already
downloaded — which means they have already been to the file, know where it is, and `path` is
an equal experience rather than a worse one. The single user turned out not to need the
widget, which is exactly what deciding on evidence looks like when the evidence comes out the
other way.

**What was found on the way, and is worth keeping for whoever asks next.** A web page cannot
fill a `path` from a picker: browsers will not tell a page where a file is, which is why
`path` renders with a disabled *Browse…* button and always will. So *choosing a file* really
is inexpressible in the schema — the case for `file` is structural, not convenience. It just
has no user with a first-minute need yet, and one user with a convenient need is what the bar
exists to refuse.

**One thing moved rather than being added.** The `voice` `choice` setting is gone: a dropdown
whose options are fixed in a manifest cannot list a voice that arrived afterwards, so the
panel's list is the picker and the answer lives in the plugin's own key-value store. That is
the namespace rule (D86) doing its job — pick a screen — and it is the first time a widget has
moved because the panel was the better one.


The first plugin-owned tab, and the one that decides `file`.

What the panel is: the clips this machine has, which voice speaks, and a way to add one. The
old dashboard's owner asked for it in his own words — *"can you make it so that I can switch
the voice? Maybe in the dashboard, like load 15 seconds of a voice and text"* — and what
shipped was an **upload, not an in-browser recording**, deliberately: a file input needs no
microphone permission prompt and no codec negotiation. That reasoning holds here and the
overlay has a hotkey to protect.

**If `file` is granted, it is base64 in a JSON body, not multipart.** The predecessor's reason
was a Python dependency it did not want; ours is the same trade in a different language —
core's `node:http` server has no multipart parser, and adding one for one widget buys a parser
core otherwise never needs. The clip is small and single-user and local.

**Whichever way `file` goes, the panel ships.** Without it, the list and the switch are a
`table`, and adding a clip is a `path` — the tenth widget, pointing at a `.wav` already on
disk. That is a worse first minute and a working panel, and it is the fallback if the eleventh
widget conversation lands on no.

### M6-7 `plugins/memory` declares a panel — and the `graph` question

**Built 2026-08-29 (D90). The graph is refused, and this time the store is the reason.** The
panel ships as a table: everything remembered, grouped by what sort of thing it is, filtered,
with the whole sentence under the row and **Forget** on it. That last one is the entire
reason a person opens this screen — *it remembered something wrong* — and it needed a new
tool: `forget` already existed and takes *words from the thing to forget*, which is right in a
conversation and wrong on a screen. On a screen the person is pointing at a row, so
`forget_one` takes the row and no best-match guess stands between what they pointed at and
what goes.

**Then the graph, and there is nothing to draw.** Backlog item 4 says *only when a real plugin
needs a chart, a canvas or a map and genuinely cannot be a schema* — and the real plugin turns
out to store **flat sentences with a category**, not a graph. The predecessor's graph was over
an Obsidian vault where the links were *authored*; here they would have to be *inferred*, and a
graph of inferred similarity is a picture that looks meaningful and is not. `groupBy` shows the
structure this store actually has. **All three answers stay on the table for whoever brings a
plugin with real edges** — a hand-written force layout, a `graph` widget, or the sandboxed
iframe — and the recommendation with them.


**The panel ships as a table**: what is remembered, when, what links to what, and a way to
forget one row. `memory.recall` already answers most of it and `forget_all` already exists;
what is missing is forgetting *one* thing, which is the entire reason a person opens this
screen — *it remembered something wrong*.

**Then, separately, the graph.** It is genuinely the nicest thing in the old dashboard and it
cost the one heavy dependency that build allowed, fenced deliberately. Here it costs more: the
page has no bundler and no framework, so a force layout is written by hand or not at all.

This is **Backlog item 4** arriving with a real user, exactly as that entry said it would —
*"only when a real plugin needs a chart, a canvas or a map and genuinely cannot be a schema."*
Three ways to answer it, decided here with the table already working:

1. **A hand-written force layout on a canvas.** Around a hundred lines, no dependency, and
   entirely ours to maintain.
2. **A `graph` widget in the schema** — core draws it, the plugin declares nodes and links.
   Consistent with everything else, and a second widget with one user.
3. **The sandboxed iframe**, for this case and not by default, which is what the backlog entry
   actually proposes.

The recommendation is **(1) if the layout is genuinely small, and otherwise (3)** — but the
table ships first either way, so the graph is never the thing blocking a person from forgetting
something the assistant got wrong.

### M6-8 `plugins/commitments` — the panel for a plugin core has never heard of

**Built 2026-08-29 (D91).** An append-only record of what you said you would do — the
statement, the day, **whose idea it was**, the state, and how many times it has been raised —
with a read-only panel grouped into Overdue, Open and Closed. Six tools, a slash command, and
a `status` line saying how much is outstanding.

**It passed the conformance suite on the first run**, with no changes to core, no changes to
the suite, and nothing added to the schema. That is the whole claim of this task tested rather
than asserted: every other panel in M6 attaches to something core already ships and could
therefore have been quietly special-cased and still passed. This one could not — it did not
exist when the screen was written. The test that says so reads `panels.ts`, `surface.ts`,
`serve.ts`, `control.ts`, `widgets.ts` and `index.html` and asserts the word is in none of
them.

**Two decisions worth keeping.** The panel is read-only because a commitment is recorded in
the conversation where it was said and closed the same way, and a second way in from a table
would be a parallel mechanism into a record whose value is that it only ever grows. And a date
is understood or it is not — *next Tuesday* is something a model resolves and this plugin has
no business guessing at, because a ledger that quietly picked a Tuesday would nudge on the
wrong day and never say why.


The seventh panel has **no owner in this project at all**, and that is why it is worth
building. Everything else in M6 attaches to something core already ships, which means every
one of them could be quietly special-cased and still pass. This one cannot: a plugin written
after the panel mechanism, by someone reading the docs, with a tab core has never seen the
name of.

What it is, from the predecessor: an append-only ledger of things you said you would do —
statement, deadline, whether you imposed it yourself, status, how many times it has nudged you.
Its own comment calls it *"the accountability spine — the thing that makes pushing him more
than noise."* It reads well as a plugin: a small store, one tool to add a row, one to close
one, a panel to see them.

**Read-only from the panel, on purpose**, matching the original: the assistant records a
commitment during a conversation, and a second write path from a table would be a parallel
mechanism into an append-only record.

> This is `plugins/hello`'s job, at the level of a screen. Hello proves the wire carries
> anything; this proves the control surface does.

### M6-9 The consent ladder — pending, provenance, preauth

**Built 2026-08-29 (D84).** `consent.ts` holds the three records and `Skills` grew a second
list: `all` is what the screen shows, `usable` is what the model is offered. **A skill nobody
has said yes to is not in the index and cannot be read** — that is the difference between a
ladder and a label, and it is the whole of what was missing. Bundled skills are live because
enabling their plugin was the yes; a marketplace install writes a preauth before the download,
spent by the folder that turns up under that name and by nothing else; a learned skill gets
`learned` written at creation and waits. A folder that simply appeared is `unknown`, which is
a fact rather than a shrug.

**Pending is derived rather than stored** — *not bundled and not yet allowed* — because a
transient fact with a row of its own is a row that outlives what it was about. And **the
screen can read a skill that is waiting**, through a reader of its own, because reading it is
how somebody decides whether to say yes.

**The two rules under it are written where a future version of that file would break them.**
`learned.ts` now says why the checker is code and never a model, and what a revise-and-recheck
loop would have to do about the ceiling if one is ever added — there is none today, and
`distil` running once and declining by returning nothing is the cheapest correct shape.


Plugins already have this and skills do not. M2-5 settled that a folder appearing is not
consent (D73), so a plugin arrives installed and not enabled and somebody says yes. **A skill
arrives and is simply live** — including a learned skill, which is *written by a model, after a
task, about what it thinks it just learned*. That is precisely the case the predecessor built
this ladder for, and it labelled it in as many words: **AI-generated — pending review**.

Three records, and the reason they are three rather than one is the part worth copying:

| Record | Lifetime | What it answers |
|---|---|---|
| **pending** | transient | is this waiting for a human right now |
| **provenance** | permanent, written once at creation | where did this come from — hand-written, bundled with a plugin, learned from a task, or installed from the marketplace |
| **preauth** | consumed once | *yes, to this exact name*, said in advance |

**Provenance is separate and permanent because the field that looks like it means something
else.** The predecessor tried to read authorship out of a usage record and found the upstream
field meant *is this curator-managed*; rows written before the marker existed were
unrecoverable. Its answer is the one to copy: **a skill with no provenance entry is shown as
unknown, not guessed.** Same discipline as the catalog's honesty flags (M1-5) — an absent fact
is displayed as absent.

And the checker sits under it, with two rules that are already this project's rules and are
worth restating where the loop is:

- **The checker is code, never a model.** Routing a self-authored skill through an LLM to check
  it makes the checker itself the unauditable thing it exists to catch. `checker.ts` is
  deterministic and stays that way.
- **A revise-and-recheck loop asks the ceiling before it dispatches, not after.** A checker that
  keeps failing and an author that keeps trying is a loop spawning fresh calls, which is the one
  shape a post-hoc ceiling never catches. M15-7's ceilings are checked *before* each round, and
  a separate round cap ends it independently.

### M6-10 The command palette

**Built 2026-08-29 (D92).** Ctrl+K from anywhere, including the chat window — a palette that
only worked once you were already on the screen it navigates would be half a palette. Enter
opens the tab the thing lives on **with its name already typed into that panel's filter**,
which is what turns *the right tab* into *the right row*.

**One endpoint over each source's existing read path**, and that turned out to be literal:
`searchable()` ranks the rows the panels themselves show. There is no second index, so a skill
that has just been forgotten is gone from the palette by the act that removed it — proved by a
test rather than argued. A plugin's panel contributes its **name and not its contents**,
because reaching inside one means a tool call and a palette that spawned every installed
plugin on every keystroke would be a search box with a startup cost.

**Fifteen lines of ranking and no dependency**: exact, then starts-with, then substring, then
subsequence, with ties broken by label so the same query gives the same order every time. A
palette whose second and third rows swap between keystrokes is one nobody trusts to press
Enter on.

**It navigates; it does not execute**, and nothing in the endpoint can. What comes back is a
tab and a word.


Ctrl+K, type, jump. Eight tabs is where a tab bar stops being navigation, and the predecessor
added this at exactly that point.

**One search endpoint over each source's existing read path** — skills, learned skills, trace
runs, plugin panels — scored and merged. No second index to keep in sync with four sources of
truth, and no dependency: exact beats starts-with beats substring beats subsequence is about
fifteen lines, and it is ranking four short in-memory lists, not tuning relevance.

**It navigates; it does not execute.** Slash commands already run things (M1-12), and M1-12's
own rule is that every command has a UI equivalent. A palette that also executed would be a
second command system with a different permission story. This one finds a thing and opens the
tab it lives on.

### M6-G — Done when

**Reached 2026-08-29.** Run rather than asserted, against a real server with three
plugin-declared panels open:

```
tabs: Activity · Skills · Tools · Library · Commitments · Memory · Voice
delete plugins/memory  ->  Activity · Skills · Tools · Library · Commitments · Voice
39 files in packages/core/src, packages/ui/src, index.html and app.css read: the word is in none
```

And the three on the same run. **M6-1**: a purge with no confirm refused with 409, a plugin's
row action going to the permission ruling rather than the guard, an unclassified route failing
closed. **M6-5**: nothing on the activity panel, a task, then that run on it after it had
ended — and exported to a file. **M6-9**: a learned skill marked *waiting for you* and absent
from the model's tool list, then live and indexed after one yes.


> **Delete `plugins/memory` while the control view is open, and its tab goes with it —
> and no file in `packages/core` or `packages/ui` contains the word `memory`.**

The same test as M0-G and M2-G, one screen further in. A control surface is where an
architecture like this usually breaks: the dashboard is the natural place to special-case
things, because it is the one screen that has to know about everything at once. If the tab
list survives a plugin being deleted mid-session, the contract held somewhere it genuinely
could have failed.

Plus, on the same run: every state-changing route guarded or declared (M6-1), a run visible in
the trace panel after the task that made it has ended (M6-5), and a learned skill sitting in
pending review until somebody says yes (M6-9).

---

## M7 — What version 1 knew

*Inserted 2026-08-29 (D93). Same method as M6 and the same source: the first Alexia, still on
this machine, **read rather than remembered**. M6 took its screen. This takes the six things
underneath the screen that this repo has no answer to yet — found by reading its `control/`,
`core/` and `adapters/` end to end and comparing against what is actually built here, rather
than against what anybody remembers building.*

### Where version 1 is, and the rule for reading it

```
C:\Users\vacla\Documents\alexia version 1
```

**Machine-local. Not in this repo, not a submodule, and never going to be.** It is a Python
app built on a gateway this project exists to replace, and vendoring any of it would vendor
that. **Read it for the reasons, not the code.** Every path named below is a file worth
opening before writing the equivalent here, because each one was lived with long enough to
have failed at least once, and the comment above the fix usually says how — the memory
pipeline's own docstring records the exact day a model marked twenty-four real memories as
duplicates and silently wrote nothing.

If the folder has moved or the machine has changed, **every task below still stands**. The
reasoning is written out here; the file is corroboration, not a dependency.

### The mapping

Six parts, ordered by **what to build first**, not by size. The largest is third.

| # | What version 1 had | Where it lives there | Where it lands here |
|---|---|---|---|
| **M7-1** | Credentials and location stripped before anything reaches a third-party model | `core/redact.py` | **core**, before dispatch |
| **M7-2** | One id joining the trace, the spend and the routing decision | `control/trace.py` → `correlate()`, `core/ledger.py`, `control/proactive.py` | **core** — a column, not a subsystem |
| **M7-3** | Memory that wrote itself down without being asked, into linked notes | `control/memory_buffer.py`, `control/memory_consolidation.py`, `core/vault.py`, `control/forget.py`, `control/memory_graph.py`, `core/embeddings.py`, `config/memory_graph.toml` | **`plugins/memory`**, and a contract question |
| **M7-4** | A voice cloned from fifteen seconds, marked up with emotion mid-sentence | `adapters/local_tts.py`, `adapters/fish_audio.py`, `core/voice_expression.py`, `core/voice_selection.py`, `control/voice.py`, `ui/control/src/FishAudioPanel.tsx` | **`plugins/voice`**, or a second one |
| **M7-5** | Buttons on a Telegram message, and a second place for it to land | `adapters/messaging.py` | **`plugins/telegram`** |
| **M7-6** | Three execution tiers, split by how much model sits in the loop | `core/script_engine.py`, `core/workflow_engine.py`, `control/workflows.py` | **`plugins/computer`**, beside `learned.ts` |

**Four more were found and are deliberately not tasks.** They are real, they are in the
Backlog with their paths, and all four wait on the same answer: **proactive messaging**
(`core/triggers.py`, `core/proactive_queue.py`, `core/quiet_hours.py`,
`core/frequency_ladder.py`), the **per-model reliability scorecard** (`core/reliability.py`),
**bounded self-healing** (`core/self_heal.py`), and **web-watch with an ad blocker**
(`core/web_watch.py`). Each needs **G12** — *may a plugin run on its own clock, and spend on
it* — which is also the question standing under M7-3.

**What is not coming across, and why.** The gateway coupling and everything in `ops/`, which
is the architecture this project replaced. `core/cc_bridge.py`, because `plugins/claude-code`
already is that. The mode badge and `/nsfw`, which are `plugins/persona`'s business — D81 said
so and it still holds. And `control/route_guards.py`, whose own twenty-line comment documents
the hole M6-1 was built not to have.

---

### M7-1 Nothing leaves this machine unread

**Built 2026-08-29 (D94).** `packages/core/src/redact.ts` is sixteen regexes and one pass,
called from `send()` in `router.ts` one line above the only `chat()` in the repo. Everything
bound for anything but `T0` is stripped; `T0` is not, because only `ollama.ts` ever writes
that tier and a model on this machine is not a third party. The owner's three exclusions are
quoted at the top of the file, and **the third one has a test** — four behavioural sentences
that must arrive whole, so a session tightening this "helpfully" goes red rather than
unnoticed. `redact.test.ts` drives the real payload through the real `send()` for `T1`, `T2`
and `T3` and asserts the key and the street are gone and *"and remember I always run late"*
is not, then reads the source to prove there is only one door for it to guard. Both halves
verified going red. **Not an eleventh invariant**, for M6-1's reason (D82): the ten are the
plugin contract, this is core's own dispatch.

**Every payload bound for a third-party model is stripped of credentials and location first,
in code, before dispatch — and everything else about the user goes, deliberately.**

This is the one item on the list that is a **hole rather than a missing feature.** D51 makes
free endpoints load-bearing: they are the default, they are how spend stays at 0.00, and their
terms permit training on what they receive. M1-3 gave this repo a `SecretStore` so a token
never reaches the database — **a different job entirely.** That guards what is *written*.
Nothing guards what is *sent*, and today a conversation containing an API key goes to a free
endpoint intact.

**The policy is three exclusions, and the third one is the point.** From the predecessor's
owner, in his own words, and worth keeping verbatim because the temptation is always to
broaden it:

> *"i dont care that it sends some information about me to the model just not passwords / env
> variables. or anything that could leak my current location. but the things how i operate,
> what i do, what i like etc. i dont care about that."*

So: credentials and env values always stripped, anything revealing where he is always
stripped, **and everything behavioural allowed on purpose.** Over-redacting the behavioural
layer would gut the thing that makes Alexia worth running, and it is not what was asked for.
A future session tightening this "helpfully" is the failure mode to guard against, which is
why the quote goes in the file.

- **It runs in the router, before the request leaves** — not at a call site somebody has to
  remember. A rule enforced by whoever remembers is not enforced.
- **It is enforcement, not instruction.** No prompt asking a model to be careful; a prompt
  cannot be relied on to hold, and this one would be relied on for exactly the payloads where
  it matters most.
- **The ceiling is stated, not hidden.** Pattern matching is deliberately narrow, never
  exhaustive — `core/redact.py` says so about itself. It catches the shapes credentials and
  addresses actually take, and it will miss something. Saying so is the difference between a
  filter and a promise.
- **Local models are not redacted.** T0 runs on this machine; stripping there would cost
  accuracy to protect against nothing, and privacy mode already withdraws `sampling`
  (`packages/protocol/src/meta.ts`) where the user has asked for more than that.

**Acceptance.** A test drives a payload carrying an API-key shape, an env assignment and a
street address through the router's free path and asserts that none of the three arrive and
the surrounding sentence does; the same payload through the local path arrives whole. One
invariant-style check that a redaction-free path to a third-party provider does not exist.

**Three things came out of building it.**

- **The variable's name is not the credential.** `OPENROUTER_API_KEY=sk-or-v1-…` loses the
  value and keeps the name, because the key-shaped rule matches first. That is exclusion 3
  working, not a gap: *which provider he uses* is behavioural, and the secret is gone.
- **Financial shapes are deliberately absent**, though version 1 carried them. It carried them
  for a rule of its own, and its card pattern eats any thirteen-to-nineteen digit run — a real
  cost paid against a payload the quote allows. Three exclusions means three.
- **Check 8 caught the first draft of the comment.** *"This is also where nothing leaves
  unread"* is the overclaim shape `no-overclaiming-strings` exists to find, in a file about
  privacy, written by the session that had just read that check. It went red on a comment,
  which is exactly the failure it was built for.

**Closed:** whose rule is this — core's, or a capability a plugin can ask past? → **G11
answered (D94): core's rule.** There is no capability, no manifest field and no setting. A
plugin never sees the outbound payload — it hands core a tool result and core dispatches —
so opting out would mean inventing a way to ask, and *a redaction a plugin can decline is a
redaction the worst plugin declines*. The legitimate case this costs is real and is priced:
a plugin whose whole job is credentials or addresses gets them stripped on the way to a
hosted model, and the answer is `T0`, where nothing is stripped because nothing leaves.

### M7-2 One id, four records

**Built 2026-08-29 (D95).** Migration 5 adds two columns to `usage`: `run_id`, and `asked`
— the router's first rung, beside the `model` that answered. `send()` writes both, the loop
carries the id, and `serve.ts` hands the run's own id to `run()` **and to the checker**,
because a review is spent because of a task and a run whose total omitted the reviews that
made it safe would disagree with the ledger about the same task. `Run.spent` is gone:
`trace.end` now takes the ledger's rows themselves, so the trace and the ledger cannot
disagree — they are the same rows. The activity table grew a **Cost** column, declaratively,
with no line of rendering (M6-4 holding). `correlate.test.ts` is the acceptance: two tasks in
one session with different totals the session number cannot separate, a 429 fallback whose
charge names both models, and a charge with no run at all.

**A run's id is on the row that says what it spent, so "why did this cost that" is a lookup
rather than an argument.**

The pieces are all built and none of them touch. `trace.ts` keeps five runs, each with an
`id`. The `usage` table (`packages/core/src/store.ts`) records `at`, `session_id`, `plugin`,
`model`, `provider`, tokens and cost, and `spend()` filters by session, plugin or model.
**A session is not a run.** Ten tasks in one sitting share a `session_id`, so the panel can
say what today cost and cannot say what *that* cost — which is the question anybody actually
has, and the only one a ceiling refusal (M15-7) makes urgent.

Version 1 solved this with one key on everything: `correlate()` in `control/trace.py` takes a
`task_id` and returns the trace run, the spend rows, the routing decisions and the proactive
message together. The plumbing was one field; the payoff was that clicking a message showed
what produced it. **The lesson is the restraint** — it did not invent a second id scheme, it
put the id it already had on the rows that were missing it.

- **A column and a field, not a subsystem.** `run_id` on `usage`, written where the loop
  already knows it.
- **The router's decision goes with it** — which model was asked, which answered, and why
  they differ. D88 already added a `turn` event carrying both names for the trace badge; the
  same two names belong on the spend row, because a 429 fallback is exactly the case where a
  cost is surprising.
- **The activity panel row becomes clickable through.** M6-5 shows what a run did; this makes
  it show what a run cost, on the same row, with no second lookup for a person to perform.
- **Honest where there is nothing to join.** A model call with no run — a background one, if
  G12 ever allows one — gets a null and says *no run recorded*, never an empty list that reads
  like something is missing.

**Acceptance.** A multi-step task runs; its trace row and its spend total are retrieved by one
id and agree with each other. A fallback on 429 shows both model names against the cost.

**Two things came out of building it.**

- **The subtraction had to go, not just gain a column.** `Run.spent` was
  *allowance-after minus allowance-before*, which two overlapping runs — one at the keyboard,
  one from Telegram — would split between them, and which could never say *which call* was
  the dear one. Replacing it with the rows themselves removed the second tally rather than
  reconciling it, and `spentOn()` sums the same rows the ledger holds.
- **The checker's spend belongs to the run.** It is a model call made *because of* a task, so
  `CheckerContext` carries the run. Without it a task's total would quietly omit the reviews
  that made it safe, and the acceptance — *they agree with each other* — would have been
  passing on a smaller number than the truth.

### M7-3 Memory that captures without being asked

**Built 2026-08-29 (D96, D97).** Core hands each finished exchange to a **new core
capability**, credentials stripped by M7-1's own scan on the way; `plugins/memory` buffers it
at no cost and turns the pile into linked notes on its own clock. **G12 answered first,
because the task said not to build until it was**: a plugin may run on its own clock, and on
it spends nothing but free — derived in `send()` from *attributed to a plugin, belonging to
no run*, which M7-2 had just made expressible. **G9 answered by the contract**: one plugin,
because a second one could not read the first's namespace and *recall* would see half a
memory. The four hard-won details are all in, each with the failure it prevents named beside
it, and `noticing.test.ts` drives the real plugin process end to end with a scripted model
where a free one would be.

**Alexia writes something down because it was worth writing down, not because the model
remembered to call a tool.**

This is the largest of the six and the one with the most real reasoning behind it. M4-3
shipped a memory plugin that works: a `facts` table, one sentence a row, ranked by keyword
overlap with a recency tiebreak, and `forget_one` from the panel (D90). **What it cannot do is
notice.** Everything in it arrives because the model chose, mid-conversation, to call
`remember` — and a model that is busy answering will not.

Version 1 ran two stages on a timer and the split is the whole design:

1. **Capture, greedily and cheaply.** Every exchange written raw. A cheap model looked at them
   five at a time and asked only *is any of this worth keeping* — a low bar, on purpose:
   *"when in doubt, keep it."* An idle Alexia made zero calls, because the batch never filled.
   → `control/memory_buffer.py`
2. **Consolidate, slowly and well.** Every twelve minutes a stronger model turned the
   survivors into short notes, decided where each belonged, and linked them.
   → `control/memory_consolidation.py`

**The bar for writing is on the floor; the filtering happens at read time.** A fact never
written cannot be recalled; a trivial fact that was written costs almost nothing to skip past.
That asymmetry is why capture is greedy — and it only works if retrieval is structured, which
is the second half.

**Linked notes, not a longer list.** `core/vault.py` is one small always-loaded hub and
everything else reached by following `[[wikilinks]]`, so **recall cost stays flat as memory
grows**. `search.js` already writes down its own ceiling — *hundreds of short sentences rather
than millions* — and this is what removes it rather than raises it. A memory could sit under
two parents at once (a person *and* a hobby) with no new machinery: one canonical note, one
link appended to each parent.

**D90 refused a `graph` widget because this plugin's links would have to be inferred.** That
refusal was right and it stays right — but a vault has **authored** links, which is the exact
condition D90 named as the thing it was waiting for. **If M7-3 ships, G8 reopens with a real
user.** That is the deferral working, not a reversal.

Four hard-won details, each fixing a failure that actually happened:

- **Code overrules the model on duplicates.** Live, 2026-08-10: a batch of twenty-four real
  candidates came back all marked duplicate. Valid JSON, nothing written, nothing crashed —
  the worst shape a failure can take. The fix: the model must **name** the note it claims a
  duplicate of, and code compares the candidate against that note's real on-disk text before
  believing it. Plain word overlap, no embeddings, and explainable — *these two share fewer
  than a third of their words* is an answer a person can check.
- **The forget cascade, in order: buffer first, then notes, then the raw log.** The
  predecessor's owner caught this himself: *"if I say forget something and in the buffer there
  is the same thing… that gets remembered in 12 minutes, it kinda loses the point."* Today's
  `forget_one` is correct precisely because there is no buffer. **Adding one without adding
  this is the bug.**
- **A tombstone every time, matched or not.** A forget that found nothing still gets recorded,
  so nobody later has to wonder whether it silently no-opped. Losing memory quietly is the one
  unrecoverable failure this kind of system has.
- **Quarantine, not a stuck queue.** A candidate whose own content breaks the call is always
  the head of the queue on the next pass, forever. After three attempts it is set aside —
  never discarded — and the rest drains.

Also there and worth taking cheaply: **certainty decay**, so an old unconfirmed fact fades
rather than sitting as truth; and a **secret pre-scan on every write**, so nothing
credential-shaped enters memory at all — the same scan M7-1 needs, on the other door.
`core/embeddings.py` is the stated upgrade path when keyword recall measurably misses: a
~25 MB quantised ONNX model, no torch and no server, with **every caller degrading to
substring search** when it is unavailable rather than failing.

**The contract question this raises is the real work.** A plugin that batches, waits twelve
minutes and calls a model is doing **background work on its own clock, and spending on it**.
Two thirds of that is already proven: `plugins/telegram` holds a poll loop open under
`lifetime: "resident"` (D77), and `sampling` is a per-request capability the protocol already
carries. The unproven third is the ceiling — M15-7 counts a task's spend, and nothing yet
counts a plugin's spend against no task at all. **Do not build the pipeline before that is
answered.** → **G12**, and **G9** for whether this replaces `plugins/memory` or is a second
plugin beside it.

**Acceptance.** Say something worth remembering, never call `remember`, wait one interval, and
find it written down and linked from the right place. Say *forget that*, and it does not come
back on the next tick. Delete `plugins/memory` and every note goes with it — invariant 5,
unchanged.

**What building it decided, and what it turned up.**

- **G12 — yes, on its own clock, and it spends nothing but free.** The ceiling is a *tier*
  rather than a number, because M15-7's spend preview — the thing that makes an expensive run
  somebody's decision — has nobody to show itself to when a timer wakes up. It is **derived,
  not declared**: `send()` reads *a plugin, and no run* as *free only*, so it is one rule in
  the place M7-1 already put one rather than a flag at each call site somebody must remember.
  The checker keeps its paid path because it runs inside a task and carries that task's id.
  This is a real tightening: `sampling` could spend to the monthly cap before today.
- **G9 — one plugin, and the contract decided it.** A second plugin *cannot read the first's
  tables* — that is the namespace rule, not a preference — so *recall* would see half the
  memory and a person would have two screens called Memory. Running the cheap one only stays
  possible, as a switch rather than as a second folder.
- **The switch is the binding, not a check.** `memory.capture` is bound on the tool **only
  while capture is on**, so with it off core resolves nothing and never hands the exchange
  over at all. Nothing new was needed: the runtime binding was always separate from the
  manifest's declaration, for exactly this sort of reason.
- **One stage where the predecessor had two.** Its cheap triage existed to keep an expensive
  model off most of the volume, and a plugin on its own clock cannot reach one. The property
  that mattered survives: an empty buffer asks nothing, so an idle Alexia costs nothing.
- **Two layers of forget, not three.** The predecessor kept a permanent raw log behind its
  buffer; a second copy of everything anybody ever said is a privacy cost paid for a feature
  nobody asked for. The cascade is the buffer, then the notes, then a tombstone every time.
- **`[]` and `null` are different answers**, and the test that found it is the one about
  quarantine: an empty array is *nothing worth keeping* and drains the buffer, while prose,
  a truncated array or an object is the model not answering and the rows keep their turn.
  Treating the second as the first is how an hour of conversation disappears silently.
- **Two bugs fell out, both older than this task.** `AWS_SECRET_ACCESS_KEY=…` walked straight
  through M7-1's egress scan — the keyword is in the *middle*, and the pattern demanded `=`
  immediately after it. And `store.select` **threw on a declared table nothing had ever been
  written to**: `create` makes it with a `rowid` and no columns, so `ORDER BY at` on a fresh
  install was a crash rather than an empty list — which is the memory panel on the one path
  nobody tests. Both fixed at the root, with the reason written where the fix is.

**G8 has reopened, exactly as written.** D90 refused a `graph` widget because *this* plugin's
links would have to be inferred. They are authored now — the model names what a note belongs
under, code drops any name it was not shown, and the link goes on both notes — which is the
condition D90 named as the thing it was waiting for. **It is not being built here**: a widget
is M6's work, the table still shows what this store has, and the recommendation in D90 stands.
What has changed is that the question now has a real user.

### M7-4 A voice that is yours

**Built 2026-08-29 (D98).** `plugins/voice` grew a second engine — `fish.js` — and
`expression.js` beside it. **G10 answered by the contract, not by taste**: a second plugin
would mean two providers of `voice.speak`, and `Plugins.capability()` returns whichever core
happened to load first, with nothing on any screen to say which is speaking. So it is one
plugin, and there is **no engine switch either** — a voice is picked in one place and where
it lives is a property of the voice. `cloud:` means yours; anything else is a Piper stem, and
`speak` reads the id. **G7's `file` was asked again and lost again**, for a new reason: this
plugin has no raw recorder, only `whisper-stream`, which returns text — so `path` is still
the equal first minute and is the shape `add_voice` already used. Expression is filtered
against the vendor's own published vocabulary after generation, and is **off with a sentence
saying why** whenever a Piper voice is speaking. **The live clone call is unverified**: there
is no key on this machine, the request shapes are tested against a stub, and the file says so
in as many words.

**Record fifteen seconds, get a voice that sounds like it — which this repo currently cannot
do, and said so.**

D89 refused the `file` widget and named exactly this as the reason: *the use case that
motivated it does not exist here*, because Piper does not clone from a recording. That was
right on the evidence at the time. **M7-4 is the real user that refusal was waiting for.** If
an engine that can clone ships, `file` gets asked again with a user that needs it — and it may
still lose, since a fifteen-second clip could equally be recorded by the plugin through
`audio.input`, which it already holds.

The predecessor's owner asked for it in one sentence — *"load 15 seconds of a voice and text
and ship it to Qwen"* — and `control/voice.py` plus `adapters/local_tts.py` are what answered
it: upload clip and transcript, build a named clone, pick which voice speaks, delete one and
have the selection fall back rather than dangle.

**It also measured why a local-only answer hurts.** Local TTS loaded the model into VRAM on
every single call: **10–30 s of load plus roughly 10 s per 20 words**, so a 500-character reply
took two minutes to arrive. That is a measured number off a machine with the same 8 GB this
plan's own facts table records, not a guess — and it is the honest argument for offering a
second engine rather than a preference for the cloud.

Two things ride along with that second engine:

- **Expression markers.** `[emotion]` tags placed inline, mid-sentence, at no token or latency
  cost — the difference between a voice and a reading. **They must be filtered against a fixed
  vocabulary after generation**, because a model that invents `[sultry]` ships a literal
  bracket into the audio: the engine speaks unrecognised text rather than dropping it.
  `core/voice_expression.py` filters against a list quoted from the vendor's own published
  reference, which is the part to copy.
- **Ogg/Opus out of the box**, which is what a Telegram voice bubble wants — and therefore what
  M7-5 wants.

**Honest about what it costs.** M2-4 refused a cloud vendor for the dependency, and that
refusal is not overturned by wanting a feature. This is why the shape is a question rather than
a decision: a second plugin keeps `plugins/voice` local-only and honest, and an engine setting
inside it keeps one voice screen. → **G10**.

**Acceptance.** Fifteen seconds and a transcript in, a named voice out, that voice speaks the
next reply. Delete the plugin and the clone goes with it. With the local engine selected,
expression is **off and says so** rather than silently doing nothing.

**Where the acceptance was met, and the one place it could not be.**

- **A clip and its words in, a named voice out, speaking the next reply** — built, and picked
  automatically, because somebody who has just cloned their own voice wanted to hear it.
- **Expression off and saying so** — the state line reads *expression is off, Piper has none*
  whenever a local voice is speaking, rather than a switch that appears to work.
- **Delete the plugin and the clone goes with it — this one is not true, and pretending
  otherwise would be the lie.** A cloned voice lives on somebody's fish.audio account, not on
  this disk. Purging takes the key, the selection, the folder and the namespace; the voice on
  the account stays until **Remove** on the panel deletes it. There is no pre-purge hook in
  the contract and adding one for a single plugin is exactly what invariant 1 exists to
  prevent, so the honest answer is that the tool says this out loud at the moment it clones.

**Three decisions came out of building it.**

- **G10 — one plugin, and the contract decided it.** Two plugins would both provide
  `voice.speak`; `Plugins.capability()` iterates and returns the first enabled provider that
  binds it, so *which voice is speaking* would depend on load order with nothing to say so
  and no way to choose. That ambiguity is worse than a summary that has to mention a key.
- **No engine setting either, which the question did not consider.** A voice is chosen in one
  place already, and where it runs is a property of the voice. A second switch would be a
  second thing to keep in step with the first, and the state where they disagree — a local
  voice with the cloud engine selected — has no meaning.
- **`file` refused a second time, on a new argument.** D89's alternative was *record the clip
  through `audio.input`, which the plugin already holds* — and it turns out not to be free:
  Whisper's `whisper-stream` returns **text**, so a clip would mean a wav recorder per
  operating system for one screen. Somebody cloning a voice already has the recording. That
  is two refusals of `file` for two different reasons, and neither was the reason expected.

**What is not verified.** The clone-creation request is written from the published shape and
has **not been run against the live API from this repo**, because there is no key here. The
synthesis and listing shapes were run live by the predecessor on 2026-08-13, and
`s2.1-pro-free` is pinned because the vendor's default is paid and answers 402 on an account
with no API credit. `fish.test.js` proves the request shapes, the error path and that a key
never reaches a message — and says in its own header what it does not prove.

### M7-5 A button in Telegram, and somewhere else to land

**A message that arrived from a phone can be answered from the phone — including the yes.**

`plugins/telegram` is good and its own source names the gap in one line
(`plugins/telegram/index.js:120`): *"You have no tools on this path, so answer from what you
know or say what you would need."* That is the plugin being honest about a real limit —
**there is nowhere to ask a permission question from Telegram**, so rather than a task hanging
on a prompt nobody can see, the path carries no tools at all. Correct, and a ceiling.

`adapters/messaging.py` shipped the mechanism that lifts it, and the hardening is the
interesting part: Telegram caps `callback_data` at **64 bytes**, so the real action never goes
inline. A short opaque token goes on the button and resolves server-side. **The limit cannot be
exceeded by construction**, whatever the action's text — which is the right shape for a
constraint that would otherwise be a length check somebody forgets.

- **The consent ladder is what actually crosses.** M15-3's modes and M6-9's yes-before-use
  already decide *what* is asked; this is a second place the asking can happen. The ruling
  stays in core; only the surface is new.
- **A fallback channel, and never a replacement.** Version 1 tried ntfy only when Telegram
  itself was unreachable, and said in the file why it is not a substitute — no buttons, no
  threading. *The message still landed somewhere* is worth having and worth not overselling.
- **Voice notes both ways**, which is where M7-4 and this meet: Ogg/Opus is what the bubble
  wants, and `voice.transcribe` already exists for the other direction.

**Acceptance.** A task started from Telegram that needs permission asks in Telegram, is
answered with a button, and the answer reaches the same ruling the app would have produced. A
callback token is opaque and shorter than 64 bytes with an action of any length.

### M7-6 Three tiers, and the cheapest one has no model in it

**The same five clicks every day should not cost a model call every day.**

Version 1 split execution by **how much model sits in the path**, and the names matter less
than the line between them:

| Tier | Model in the path | Cost |
|---|---|---|
| **skill** | orchestrates every step | full |
| **workflow** | deterministic steps, a few decision points | partial |
| **script** | none at all | ~none |

**The zero-cost guarantee was structural, not a promise.** `core/script_engine.py` never
imports the gateway or the spend ledger, so a script **cannot** bill even by accident — there
is no code path from there to one. That is the trick worth stealing: a rule enforced by the
import graph survives an edit that a comment does not.

This repo has the top rung and the bottom one is missing. `learned.ts` (M4-5) is a model
writing a skill for itself, and `plugins/computer` (M4-2) can drive the machine but only with a
model deciding each step from a screenshot. **The middle and bottom rungs are the answer to
"computer control is slow and expensive"** — most of what anybody wants it for is the same
sequence every time, and paying a model to re-derive it is the waste.

Two design rules came with it and both are about not accidentally building an interpreter:

- **Steps come from a whitelisted registry, never a shell string in a JSON file.** A workflow
  definition is data a person edits by hand; if running it executed arbitrary strings, editing
  one would be writing code. The registry is the difference.
- **A later step may reference an earlier step's actual result** (`{step_id}`), which is what
  makes a decision point worth having — the model's answer is what the next deterministic step
  acts on, not a waypoint between two clicks.

**This is the biggest contract question of the six**, which is why it is last. A tier that runs
without a model is a plugin executing a stored plan, and *who stores it, who approves it, and
what it may touch* are all M15-3 and M6-9 questions wearing new clothes. **Do not start here.**
The one thing to take early and cheaply is the import-graph guarantee, the day anything in this
repo claims to be free.

**Acceptance.** A recorded sequence replays with **zero** rows added to `usage`, proven by a
check that the module cannot reach the provider layer at all. A workflow with one decision
point spends once, not once per step. Every step is something the permission ladder already
knows how to rule on.

### M7-G — Done when

> **A free-model request is provably stripped of a credential it contained, a cost is traceable
> to the run that spent it, and Alexia remembers something nobody told it to remember — then
> forgets it and it stays forgotten.**

Three of the six, chosen because they are the three that are hard to fake. The gate is
deliberately not *all six shipped*: M7-4 and M7-6 both hang on questions this milestone raises
rather than answers, and a gate that waits on an unanswered question is a gate that gets
waived.


---

## Backlog

Real, ordered, not scheduled. Nothing here blocks a milestone.

1. **macOS and Linux** — a port, not a rewrite, if invariants 6 and 7 held.
2. **Wake word** — the genuinely hard half of renaming. Wake-word detection needs a model
   trained for one specific phrase, so a custom wake word means training per user or licensing
   a service. Separate feature, separate project. The display name shipped at M1-11 for free.
3. **OS-level permission enforcement** — AppContainer or restricted tokens, and only for
   filesystem and shell, the two capabilities carrying most of the risk. Thinly documented,
   fiddly, and exactly the kind of code that is written badly by AI and cannot be debugged by
   someone who does not write Win32 by hand. After the contract is stable and there are real
   plugins to test against. Not before.
4. **Sandboxed iframe plugin UI** — only when a real plugin needs a chart, a canvas or a map
   and genuinely cannot be a schema. For that case, not by default.
5. **A Python plugin SDK** — a client library, not a rewrite, and where ML plugin authors live.
6. **A full window** — not ruled out, but the overlay is the primary surface.

The next four came out of reading version 1 (M7). Each is real, each was lived with, and each
waits on **G12** — *may a plugin run on its own clock, and spend on it.* Paths are in
`C:\Users\vacla\Documents\alexia version 1`, to read for the reasoning rather than the code.

7. **Proactive messaging** — Alexia speaking first, which this repo has no shape for at all.
   Four parts and the last two are what make it bearable: conditions polled on a timer
   (`core/triggers.py`, `core/proactive_conditions.py`), a **draft-then-confirm queue** so
   nothing ever sends unattended (`core/proactive_queue.py`), **quiet hours** as a hard
   silence (`core/quiet_hours.py`), and a **frequency ladder** that self-throttles 1 → 2 → 3 →
   5 messages a day on how you actually reacted (`core/frequency_ladder.py`). That last one is
   the good idea — an assistant that notices it is being ignored and backs off on its own.
   Plugin-shaped, and it needs M7-5 first: a message you cannot answer from your phone is a
   notification, not a conversation.
8. **A per-model reliability scorecard, on disk** (`core/reliability.py`) — success and
   failure per model, surviving restart, so a model that has been degrading for three days
   sinks toward the back of its own fallback chain before anyone notices. M1-8 already falls
   back on 429 and 5xx; what it has no memory of is **which model keeps doing that**. Two
   failure kinds tracked separately, because they are detected in different places: the call
   never came back, and the call came back unusable.
9. **Bounded self-healing** (`core/self_heal.py`) — a failure diagnosed by a model that
   **proposes and never applies**, with a *hardcoded* list of files it may not even propose
   touching: its own spend caps, its own redaction, its own guards. The bound is the whole
   value: a system that can edit its own safety rails does not have any. Only interesting
   once there is enough running to fail interestingly.
10. **Web-watch with an ad blocker** (`core/web_watch.py`) — watch a URL, fire on meaningful
    change, and the noise filtering is the part worth having: a block that changes on every
    single poll is auto-suppressed, while an explicit selector — *watch the photo* — bypasses
    both the ad filter and the suppressor, because it is the one thing somebody asked about.

---

## Gates that need you

Every `[GATE]` in one place, so none is a surprise.

| Gate | What it needs from you |
|---|---|
| **P0-1** | Approve making the repo public, and the first push |
| ~~**M1-13**~~ | Waived 2026-08-28 (D64). The tester session rolls into **M2-8**. |
| **M2-8** | A person, a clock, no helping. Deferred 2026-08-28 (D79), **not** passed |
| **M3-1+** | Create the D1 database, set `ADMIN_TOKEN`, `wrangler deploy`. The registry is written and has never been deployed |
| **M3-8** | Same as M2-8. Deferred with it |
| **M3-G** | Someone who is not you writes a plugin from the docs |
| **M3-G+** | Approve opening the registry to third-party submissions — needs the conformance suite green, which it is |
| **M3-7+** | Generate the publisher signing key and put the public half in front of users. Until then every signature reads *not checked*, which is the honest state |
| **M4-7** | Ask Anthropic about the Claude Code integration, in writing. The plugin ships **off** until that answer exists |
| **M5-3** | Apply to SignPath Foundation, set `SIGNPATH_API_TOKEN` and `SIGNPATH_ORGANIZATION_ID`, and approve publishing. `.github/workflows/release.yml` is written and has never been run |
| **M5-6** | The real cold-install test. Deferred with M2-8 |
| any | Spending money, installing system software, emailing anyone, publishing anything |

Standing to-dos carried from `questions.md`, each attached to the task that closes it:

- Licence files before the first public push → **P0-1**
- Read the agentskills.io spec properly → **P0-5** *(done in outline: `name` must match the
  folder, `description` ≤ 1024 chars and must say what **and when**, progressive disclosure is
  three levels, `skills-ref validate` exists)*
- Anthropic's usage terms for Claude Code → **M4-7** *(researched, see D53; written
  confirmation still outstanding)*
- Each provider's terms before free-tier pooling ships → **M1-6**
- Manifest schema and wire protocol as documents before building → **P0-3, P0-4**

---

## New questions this plan raises

For `questions.md`. Each one came out of planning and none of them blocks starting.

- **G1.** Does the typed storage API cover a real plugin, or does the first join force a
  proper query layer? *Decide at M2, with voice as the evidence.*
- **G2.** How does a plugin written in something other than JavaScript declare its runtime?
  Node is bundled and free; Python is not. Ship `uv`, require system Python, or restrict the
  first-party set to Node? *Decide at M3, with the author docs.*
- **G3.** Which MCP revision is pinned, and what is the policy for moving? Pin-and-hold, or
  follow with a deprecation window? *Decide at P0-3.*
- **G4.** Does an MCP-compatibility-mode server appear in the plugin marketplace at all, or
  only behind an "add a server" affordance? The review-bar distinction is the whole reason
  there are two marketplaces. *Decide at M3-6.*
- **G5.** Can a small local model actually *plan*, or only execute? Alexia.md flags this as
  worth testing rather than assuming. **Test it at M15-1** on this machine — qwen3-class 7–9B
  at Q4, 8–16k context. The answer decides whether Local mode is a real agent or a chat window.
- **G5. Answered 2026-08-27 at M15-1 — yes (D62).** qwen3:8b at Q4, driven by the real loop
  with no hints, listed a folder, read two files, diffed them and answered correctly in three
  steps. 113s, which is slow rather than wrong. **Local mode is a real agent.** The one-row
  change the plan anticipated turned out to need a second one: every local model is `T0`
  whether it is 1B or 8B, so `tier` could not carry it and `PLANNER` — a 7B floor in
  parameters — is the axis the evidence is actually about. Measured on this machine only; a
  weaker GPU is a different question and is not claimed.
- **G6.** What happens to the free-tier pool when a provider changes its terms mid-release?
  A kill switch for provider entries, the same way the registry has one for plugins?
  *Decide at M1-6.*
- **G7.** Is there any honest way to express *give me a file* in a schema whose whole point is
  that a plugin never draws? `file` has one user (voice, a 15-second clip), which is this
  schema's own bar for refusing it — and unlike every other refusal, there is no workaround
  inside the ten: `path` asks a person to go and find a `.wav` themselves. *Decide at M6-6,
  with voice as the evidence — the same method M2-1 used.*
- **G8.** Does a plugin ever get to draw something core cannot? The memory graph is the first
  real case of Backlog item 4 — *a chart, a canvas or a map that genuinely cannot be a schema*
  — and the three answers are a hand-written force layout, a `graph` widget with one user, or
  the sandboxed iframe for this case and not by default. Whichever wins sets the precedent for
  every plugin after it, so it is worth deciding on evidence rather than on the first one that
  works. *Decide at M6-7, with the table already shipped so nothing is blocked on it.*
- **G8. Reopened 2026-08-29 at M7-3, with a real user.** The vault shipped and its links are
  **authored** — the model names what a note belongs under, code drops any name it was not
  shown, and the link goes on both notes — which is the condition D90 named. The refusal is
  not overturned and nothing was built: a widget is M6's work, and D90's recommendation (a
  hand-written force layout if it is genuinely small, otherwise the sandboxed iframe) stands.
  *Decide when somebody wants to look at the shape of their own memory and the table is not
  enough — which is a question about use, and there is no use yet.*
- **G9. Answered 2026-08-29 at M7-3 — one plugin (D97).** Not on the balance of screens: the
  **contract decided it.** A second plugin cannot read the first's tables, so *recall* would
  see half the memory and there would be two tabs called Memory with no way to join them.
  Running the cheap one only survives as a switch, which is one toggle rather than one folder.
- **G10. Answered 2026-08-29 at M7-4 — one plugin, and no engine setting either (D98).** The
  contract decided the first half: two plugins would both provide `voice.speak`, and
  `Plugins.capability()` returns the first enabled provider it finds, so which voice speaks
  would depend on load order with nothing to say so. The second half the question did not
  ask — **a voice is already chosen in one place, so where it runs is a property of the voice
  rather than a second switch** to keep in step with the first. `file` was asked again and
  refused again on a new argument: the plugin has no raw recorder, only one that returns text.
- **G11. Answered 2026-08-29 at M7-1 — core's rule (D94).** No capability, no manifest field,
  no setting. The bias held, and building it added a structural reason the plan did not have:
  **a plugin never sees the outbound payload.** It hands core a tool result and core
  dispatches, so an opt-out would first need a way to ask for one — a new contract surface
  whose only purpose is to send more. The legitimate case is real and is priced rather than
  denied: a plugin whose job is credentials or addresses gets them stripped on the way to a
  hosted model, and its answer is `T0`, where nothing is stripped because nothing leaves.
- **G12. Answered 2026-08-29 at M7-3 — yes, and on its own clock it spends nothing but free
  (D96).** The ceiling is a **tier rather than a number**, because M15-7's spend preview has
  nobody to show itself to when a timer wakes up, and the monthly cap bounds the total rather
  than this. **Derived, not declared**: `send()` reads *attributed to a plugin, belonging to
  no run* as *free only*, which M7-2's `run_id` had just made expressible — one rule in the
  place M7-1 already put one, rather than a flag at every call site. The checker keeps its
  paid path because it runs inside a task and carries that task's id. A real tightening:
  `sampling` could spend to the cap before this. **Backlog 7–10 are unblocked** and inherit
  the same ceiling — a plugin on its own clock may wake, and may not bill anybody for it.

---

## Change log

Newest first. Every entry here is also in Alexia.md's decision log.

| Date | Entry |
|---|---|
| 2026-08-29 | **D98** — **a voice that is yours, and the engine it costs, said out loud.** M7-4, G10 answered. `plugins/voice` gained a second engine and an expression pass; **it is one plugin, and the contract decided that** — two plugins would both provide `voice.speak`, and `Plugins.capability()` returns whichever core loaded first, so *which voice is speaking* would depend on load order with nothing on any screen to say so. **And no engine setting either**, which G10 did not consider: a voice is already chosen in one place, so where it runs is a property of the voice rather than a second switch, and the state where the two disagree has no meaning. **M2-4's refusal of a cloud vendor is priced rather than overturned** — Piper still speaks unless somebody has picked a cloned voice, and picking one is the yes. **`file` was refused a second time on a new argument**: D89 said the clip could be recorded through `audio.input`, and it cannot — `whisper-stream` returns text, so a recorder would be a platform-specific capture path per operating system for one screen, and somebody cloning a voice already has the recording. Two refusals of `file`, two different reasons, neither the one expected. **Expression is filtered, not trusted**: an unrecognised marker is *spoken* rather than dropped, so the vocabulary is quoted from the vendor's published reference and the model's output is filtered against it afterwards — and an annotator that changed the words has its whole answer discarded, because a voice saying something slightly different from the screen is a bug nobody can see. With a Piper voice speaking it is **off and says why**. **One acceptance line is not met and is written down rather than fudged**: a cloned voice lives on an account, not on this disk, so deleting the plugin does not delete it. There is no pre-purge hook and adding one for a single plugin is what invariant 1 exists to prevent, so the tool says so at the moment it clones. **The live clone call is unverified** — no key on this machine — and the file says which shapes were run against the real API and which were not. |
| 2026-08-29 | **D96** — **a plugin may work on its own clock, and on it spends nothing but free.** G12 answered at M7-3, and it had to be answered first because the task said not to build until it was. Half was already true — `resident` (D77) and `sampling`. The unanswered half was the ceiling, and the answer is that **the ceiling is a tier rather than a number**: M15-7's spend preview is what makes an expensive run somebody's decision, and when a timer wakes up there is nobody to show it to. So free tiers and this machine, always; a paid model never. **It is derived rather than declared**, which is the part worth keeping: `send()` reads *attributed to a plugin, belonging to no run* as *free only*, and M7-2's `run_id` is what made that sentence expressible a day earlier. One rule, in the same place M7-1 put one, instead of a flag at every call site — because a flag at a call site is a flag somebody forgets on the one that matters. The checker keeps its paid path by construction: it runs inside a task and carries that task's id. **This is a real tightening** — until today `sampling` could spend to the monthly cap, and a resident plugin waking every twelve minutes had nothing between it and the money. The refusal says which wall it hit, because *raise your cap* is the wrong advice here. **Backlog 7–10 are unblocked** and inherit the ceiling: proactive messaging, the reliability scorecard, bounded self-healing and web-watch may all wake on their own, and none of them may bill anybody for it. ponytail: no per-plugin allowance — the upgrade, if somebody wants their phone answered by a frontier model, is a monthly figure granted per plugin on the Library screen and read in the same place. |
| 2026-08-29 | **D97** — **Alexia notices things now, and the switch is the binding.** M7-3, G9 answered. Core hands each finished exchange to a **new core capability** and forgets about it — `void`, caught, never awaited, because a memory that could delay an answer is one people turn off and one that could throw would break a conversation over a flourish. **Credentials are stripped on the way and location is not**: what may be written down is not what may be sent, an address is worth remembering and only dangerous when it leaves, and it is M7-1's own scan on the other door. **G9 was decided by the contract rather than by taste** — a second plugin cannot read the first's tables, so *recall* would see half the memory; running the cheap one only survives as a toggle. **The consent lives in the runtime binding**: the capability is bound only while capture is on, so with it off core resolves nothing and never hands the conversation over at all — a stronger promise than taking it and dropping it, and it needed no new mechanism. **One stage where the predecessor had two**, because its cheap triage existed to keep an expensive model off the volume and a plugin on its own clock cannot reach one; the property that mattered survives, since an empty buffer asks nothing. **Two layers of forget, not three** — its permanent raw log is a second copy of everything anybody ever said, which is a privacy cost paid for a feature nobody asked for. All four hard-won details are in: code overrules a model that claims a duplicate, the cascade clears the buffer first, a tombstone is written whether or not anything matched, and a batch that breaks the call is set aside after three tries and never discarded. **Building it turned up two bugs older than the task** — `AWS_SECRET_ACCESS_KEY=…` walked through M7-1's scan because the keyword is in the middle, and `store.select` threw on a declared table nothing had ever been written to, which is the memory panel on a fresh install. Both fixed at the root. **G8 has reopened with a real user**: these links are authored, which is the condition D90 named, and nothing was built on it — the refusal stands and now has something to be asked about. |
| 2026-08-29 | **D95** — **a cost belongs to a run, and the trace stopped keeping its own tally.** M7-2. Two columns on `usage` — `run_id`, and `asked` beside the `model` that answered — written by `send()`, carried by the loop, handed down by `serve.ts`. **The restraint version 1 showed is the whole lesson**: it did not invent a second id scheme, it put the id it already had on the rows that were missing it, and that is what this is. **The subtraction had to go, not merely gain a column.** `Run.spent` was the allowance before the run subtracted from the allowance after, which two overlapping runs — one at the keyboard, one from Telegram — would split between them, and which could never say which *call* was the dear one. It is replaced by the ledger's own rows, so the trace and the ledger cannot disagree about a run: they are the same rows, and `spentOn()` sums them. **The checker's spend goes on the run too**, because a review is a model call made because of a task, and a total that omitted the reviews that made a task safe would have passed the acceptance on a number smaller than the truth. **The activity table grew a Cost column and nothing else changed** — declared like every other column, drawn by the same function, which is M6-4 still holding three tasks later. And the null case is a sentence rather than a zero: a run with no charges reads *no model call was recorded against this run*, because `$0.0000` is a different claim and sometimes a wrong one. |
| 2026-08-29 | **D94** — **the payload is read before it goes, and the third exclusion has a test.** M7-1, G11 answered. `redact.ts` is sixteen regexes and one pass, called from `send()` one line above the only `chat()` in the repo — **there is one door out of this codebase**, and a test reads the source to say so, because a rule enforced at whichever call site somebody remembers is not enforced. Everything bound for anything but `T0` is stripped; `T0` is not, on the fact that only `ollama.ts` ever writes that tier. **The interesting half is what is deliberately allowed.** The owner's quote sits at the top of the file and *"the things how i operate, what i do, what i like"* is exclusion 3, so four behavioural sentences are asserted to arrive **whole** — a future session tightening this helpfully goes red rather than unnoticed, which is the only form a comment saying *do not broaden this* can take and be believed. Version 1's IBAN and card rows did not come across: it carried them for a rule of its own, and a pattern that eats any thirteen-digit run is a real cost paid against a payload the quote permits. **G11 is core's rule**, and building it supplied the argument the plan had not: a plugin never sees the outbound payload at all, so an opt-out would mean inventing a way to ask for one. The legitimate case is priced instead of denied — a plugin whose job is addresses gets them stripped on the way out, and its answer is `T0`, where nothing is stripped because nothing leaves. **And check 8 caught the first draft of the comment**: *"this is also where nothing leaves unread"* is precisely the overclaim `no-overclaiming-strings` exists to find, written into a privacy file by the session that had just read that check. It went red on a comment, which is the failure it was built for. |
| 2026-08-29 | **D93** — **version 1 was read end to end, and it knew six things this repo does not.** M7 inserted. The first Alexia is still on this machine (the path is in M7's own header, deliberately, so nobody has to guess); M6 took its screen, and this is what was underneath — its `control/`, `core/` and `adapters/` compared against what is actually built here rather than against what anybody remembers building. **One of the six is a hole rather than a missing feature**: D51 makes free endpoints the default and nothing strips a credential or a location before a payload reaches one, which `core/redact.py` did in code, with the owner's own three exclusions and the third — *everything behavioural goes, deliberately* — quoted so a later session cannot tighten it into uselessness. The rest are ordered by what to build first rather than by size: **one id** on the spend row, because `usage` records a `session_id` and ten tasks in one sitting share it, so the panel can say what today cost and not what *that* cost; **memory that captures without being asked**, the largest, carrying four failures already paid for — a model marking twenty-four real memories duplicate and silently writing nothing, a forget undone twelve minutes later by a buffer nobody cleared, a queue frozen forever on one bad row, and a tombstone for the forget that matched nothing; **cloning**, which is the real user D89's `file` refusal was waiting for; **a button in Telegram**, because that plugin's own source says *you have no tools on this path* and means there is nowhere to ask; and **three execution tiers**, whose zero-cost bottom rung was guaranteed by the import graph rather than by a comment. **Four more are in the Backlog, not tasks**, all waiting on the same question: proactive messaging, a reliability scorecard, bounded self-healing, web-watch. That question is **G12 — may a plugin run on its own clock, and spend on it** — half-answered already by `resident` and `sampling`, and unanswered where it matters, since M15-7 counts what a task spends and a plugin waking every twelve minutes spends against no task at all. **Nothing is vendored and nothing is a submodule**: it is a Python app on the gateway this project replaced, so every path is named to be read for its reasons, and every task stands if the folder is gone. |
| 2026-08-29 | **D92** — **the palette searches the panels themselves, and M6 is done.** M6-10. Ctrl+K from anywhere; Enter opens the tab the thing lives on with its name already in that panel's filter, which is what turns *the right tab* into *the right row*. *One search endpoint over each source's existing read path* turned out to be literal: it ranks the rows the tables show, so there is **no second index** and a skill that has just been forgotten is gone from the palette by the act that removed it — a test says so rather than an argument. A plugin's panel contributes its **name and not its contents**, because reaching inside one is a tool call and a palette that spawned every plugin on every keystroke would be a search box with a startup cost. Fifteen lines of ranking and no dependency, with ties broken by label so the same query gives the same order twice — a palette whose rows swap between keystrokes is one nobody trusts to press Enter on. **It navigates; it does not execute**, and the endpoint cannot: what comes back is a tab and a word. **M6-G was then run rather than asserted** — three plugin panels open, `plugins/memory` deleted, its tab gone, thirty-nine files in core and the shell read and the word in none of them; and on the same run a purge refused without a confirm, a run on the activity panel after the task that made it had ended, and a learned skill sitting at *waiting for you* until one yes. |
| 2026-08-29 | **D84 built** — **a skill a model wrote now waits, and the three records stayed three.** M6-9. `Skills` grew a second list: `all` is what the screen shows and `usable` is what the model is offered, and **a skill nobody has said yes to is in neither the index nor anything the model can read**. That is the difference between a ladder and a label, and it was the whole of what was missing. Bundled is live because enabling the plugin was the yes; a marketplace install writes a **preauth** before the download, spent by the folder that turns up under that name and by nothing else; a learned skill gets `learned` written at creation and waits, because nobody asked for it. A folder that simply appeared is `unknown` — a fact, not a shrug. **Pending is derived rather than stored**, *not bundled and not yet allowed*, so there is no third place for it to disagree with the other two and no transient row outliving what it was about. Two things fell out of building it. **The screen needs its own reader**: a review screen that cannot open the thing under review is a screen asking you to guess, so `Skills.text` reads any skill on disk while `read` — the model's path — reads only the allowed ones. And **two tables on one screen cannot share a row-action key**, since a press is looked up by key; the learned list uses two keys of its own reaching the same two operations. The two rules under the ladder are now written in `learned.ts`, where a future version of that file would be the thing to break them. |
| 2026-08-29 | **D91** — **the panel mechanism held for a plugin that did not exist when it was written.** M6-8. `plugins/commitments` is an append-only record of what you said you would do — statement, day, **whose idea it was**, state, and how many times it has been raised — with a read-only panel grouped into Overdue, Open and Closed. It **passed the conformance suite on the first run**, with no change to core, no change to the suite and nothing added to the schema. That is this task's whole reason: every other panel in M6 attaches to something core already ships, so any of them could have been quietly special-cased and still passed, and this one could not. The test that says so reads the six files where a name would have had to appear and asserts it is in none of them. Two decisions came out of writing it. **The panel is read-only**, because a commitment is recorded in the conversation where it was said and closed the same way, and a second way in from a table would be a parallel mechanism into a record whose value is that it only ever grows. And **a date is understood or it is not** — *next Tuesday* is something a model resolves and this plugin has no business guessing at, since a ledger that quietly picked a Tuesday would nudge on the wrong day and never be able to say why. It says so when it does not understand one, rather than dropping it. |
| 2026-08-29 | **D90** — **the graph is refused, and the store is the reason.** M6-7, G8 answered. The memory panel ships as a table — everything remembered, grouped by what sort of thing it is, the whole sentence under the row, and **Forget** on it. That last one is why a person opens this screen at all, and it needed a new tool: `forget` already existed and takes *words from the thing to forget*, which is right in a conversation and wrong on a screen. On a screen somebody is **pointing at a row**, so `forget_one` takes the row and no best-match guess stands between what they pointed at and what goes. **Then the graph, and there is nothing to draw.** Backlog item 4 asks for *a chart, a canvas or a map that genuinely cannot be a schema*, and the real plugin turns out to store flat sentences with a category. The predecessor's graph was over an Obsidian vault where the links were **authored**; here they would have to be **inferred**, and a graph of inferred similarity is a picture that looks meaningful and is not — which is a worse failure than no picture, because nobody can tell. `groupBy` shows the structure this store actually has. The three answers stay open for whoever brings a plugin with real edges — a hand-written force layout, a `graph` widget, the sandboxed iframe — and so does the recommendation. **Two widget questions asked on evidence, two refusals, and neither for the reason expected**: `file` because its single user could not do the thing it was wanted for, `graph` because its single user has no graph. That is what deferring to the evidence is for. |
| 2026-08-29 | **D89** — **`file` is refused, and the single user is the reason.** M6-6, G7 answered. The panel ships either way and it did: a `table` of every voice this machine has, *Speak in this* and *Remove* on the rows, `path` plus an `action` for bringing your own — the first tab core has never heard the name of. What decided `file` is that **the use case that motivated it does not exist here.** The predecessor's owner asked for *load 15 seconds of a voice and text*; that is voice cloning, it belongs to a text-to-speech vendor this project refused at M2-4 for the dependency it costs, and **Piper does not clone from a recording**. What a person can actually do is bring a Piper voice they already downloaded — which means they have already been to the file and know where it is, and `path` is an equal first minute rather than a worse one. D83 deferred this so it could be decided on evidence; the evidence came out the other way, which is the deferral working rather than failing. **The structural finding is kept for whoever asks next**: a browser will not tell a page where a file is, so a `path` can never be filled by picking — which is why it renders with a disabled *Browse…* — and *choosing a file* is therefore genuinely inexpressible in the schema. That is a real argument, waiting on a real user. One user with a convenient need is what the bar exists to refuse. **And one widget moved rather than being added**: the `voice` `choice` setting is gone, because a dropdown whose options are fixed in a manifest cannot list a voice that arrived afterwards. The list is the picker now and the answer lives in the plugin's own store — the namespace rule (D86) doing what it is for. |
| 2026-08-29 | **D88** — **the trace got a memory, and the two consumers stayed two.** M6-5. The live trace is a progress indicator: it exists while the task does and goes with it. `trace.ts` is the record — the **same event stream read by a second consumer**, keeping what the loop did rather than what the model was shown. Those are different on purpose (M15-6 collapses old steps and drops raw tool output once what was learned from it is recorded), and trimming the panel because the context was trimmed would be one decision serving two jobs badly. Five runs, in memory, gone on restart, with the predecessor's reason kept word for word: *restarting and finding an empty history is the honest behaviour for something that was never meant to be a permanent log* — a person who wants one exports it. Three small things came across and each is worth more than its size. **`backtrack`**: a step that begins while the one before it is in error is a retry, and saying so turns a flat list into an agent visibly recovering. **Two model labels**: asked-for and answering differ when the router falls back on a 429 (M1-8), and the header badge shows one — so a trace showing one too would make the fallback invisible in the one place it is explicable. That needed a new loop event, `turn`, carrying both; the router's plan already knew them and nothing had ever asked. And **export is one run as text in a file**, because *send it to somebody* is the sentence it exists for — with the detail on screen rendered by the same function, so what somebody reads is exactly what they send on. Exporting is also the guard's first declared-safe core row action: it adds a file and takes nothing away, and everything of core's not on that short list still needs a confirm. |
| 2026-08-29 | **D87** — **three panels, one widget, and the one thing that did not fit was the finding.** M6-4. Four core tables — installed skills, the ones Alexia wrote, every tool every enabled plugin offers, and what is on this machine — drawn by the same function that draws a plugin's panel, with **not one line of bespoke rendering** between them. That was the whole test: *if any of them needs a line of its own, `table` was the wrong widget*, which is why they were one task and not three. **What did not fit was `edit`.** A textarea is not one of the eleven, and the honest answer was to leave editing a learned skill where M4-5 put it — beside the attribution line at the moment it fires, which is also the only moment a person can see what it did — rather than grow the widget for one user or special-case the screen. The panel answers the week-later question instead: **what was this learned from**, written into the skill at distil time, because the skill's own text cannot say — a model wrote that text. A skill from before the record exists is shown as *not recorded*, never guessed, which is the catalog's honesty rule (M1-5) in a second place. Two rules from the old dashboard came across unchanged and are now load-bearing: **read-only unless this screen is the only owner** — the plugins screen owns installing and removing, `tooling.ts` reads the plugins, so the only write path here is *forget a skill* — and **a broken thing is a row with a reason, not an absence**. That one write path is guarded by M6-1 rather than by `rule()`, because core acting on core's own data has no tool call to rule on; and a bundled skill is refused with a sentence rather than having no button, because a missing button answers nothing. |
| 2026-08-29 | **D83 built** — **the eleventh widget shipped, and it invented nothing.** M6-3. `table` is granted, and the two claims that made granting it cheap both held in code. **A row action is an `action`**: one lookup, one `rule()`, the same two-step question — it just carries the row it is about, and the question appears beside that row rather than under a button. And **rows arrive over MCP's own `structuredContent`**, `{ rows: [...] }` with a string `id` on each, because the protocol already has an envelope for structured tool output and inventing a second one is how a contract grows a dialect. It is the only widget that needs a running plugin, which is exactly the division M6-2 set up: the panel draws from the manifest while the process is stopped, and asks for its contents when a person opens it — through the same gate as any other call, so a `rows` tool that never declared itself read-only is asked about instead of quietly run. Three ways an author gets the answer wrong are three sentences naming what was expected, never a blank list. The refactor it forced pays for itself: **the permission ruling is written once now** and used by four callers, the copy made for `/api/command` a task earlier having already started to drift from its original. |
| 2026-08-29 | **D86** — **a plugin declares its own tab, and that cost a contract revision.** M6-2. The control surface's tab list is **assembled**: core contributes the tabs whose data core owns, and every other one is a `panel` in the manifest of a plugin somebody enabled. There is no list of tabs anywhere that a person types into, which is the whole point — the previous dashboard listed nine by hand in one `App.tsx` and grew a 480-line panel for one text-to-speech vendor inside its own source tree, and a dashboard is where an architecture like this usually breaks because it is the one screen that has to know about everything at once. `panel` is a manifest field, so **`alexia_protocol` goes to 3** and `MIN` rises to 2 with it: the *one revision back* promise, kept for the first time rather than described, and the first-party plugins migrated by changing one character. Two things fell out of building it and both are better than what was there. **`settings` and `panel.widgets` are one namespace**, because a widget's value is stored once and two declarations of it could disagree about its type — so the same key twice is a load error and choosing the screen is the author's job. And **the widget renderer moved to one file** that both screens use; a second renderer would have been a second set of rules about where a `password` goes, and the two would have drifted on the day one of them was fixed. **Invariant 1 now reads `packages/ui` too**, added while it still passed trivially, which is the only time a rule is free — and it is what makes M6-G a check rather than a hope. |
| 2026-08-29 | **D85** — **classifying the routes found the one route that was not classified anywhere: a slash command was a tool call with no gate in front of it.** M6-1, and it was the *reason per entry* that did it, not the list. Sixteen of the seventeen paths had a sentence that made them reversible or a sentence that made them dangerous. `/api/command` had neither, because it is two different things wearing one syntax: core's own commands set a mode or a pin — one word to change back, with the current value on screen beside the control — and **a plugin's command is a tool call under a short name**. That half was reaching `callTool` directly, while the identical call from an action button and the identical call from the agent loop both went through `rule()`. So it goes through the same ruling now, asked the way `/api/action` asks — this request carries no stream to put a question down, so the first call answers `ask` and the second carries the person's yes, and `blocked` still has no second call. Nothing about the two commands that exist changes: both declare `readOnlyHint`, so both still run unasked in the default mode. **The entry that could not be written is the finding.** Had the reason been optional, `/api/command` would have gone on the safe list with a path and no sentence, and the hole would still be there — which is the argument for the rule, made by the rule. |
| 2026-08-29 | **D84** — **the consent ladder reaches skills, and provenance is a separate permanent record.** M6-9. A plugin arrives installed and not enabled (D73) and a skill arrives simply live — including a **learned** skill, which is written by a model, after a task, about what it thinks it just learned. That is the exact case the predecessor labelled *AI-generated — pending review*, and it is the one place in this product where something the user never asked for starts working on its own. Three records rather than one, because they have three lifetimes: **pending** is transient, **provenance** is permanent and written once at creation, **preauth** is consumed once and means *yes, to this exact name*. Provenance is separate because the predecessor tried to read authorship out of a usage field and found it meant *is this curator-managed*, with rows written before the marker unrecoverable — so a skill with no provenance entry is shown as **unknown, not guessed**, the same discipline as the catalog's honesty flags. Two rules restated where the revise-and-recheck loop actually lives: the checker is **code, never a model**, because routing a self-authored skill through an LLM makes the checker itself the unauditable thing it exists to catch; and the loop asks the ceiling **before** each dispatch, since a checker that keeps failing and an author that keeps trying is a loop spawning fresh calls, the one shape a post-hoc ceiling never catches. |
| 2026-08-29 | **D83** — **`table` is the eleventh widget, and `file` and `graph` are not — yet.** M6-3. `ui-schema.md` said an eleventh *"is a conversation"*; this is that conversation held rather than skipped. What the ten cannot express is **a list of things with actions on each one**, and the evidence is not a preference: the predecessor hand-wrote that same object four times, and the second one's own comment says *"mirrors SkillsTab.tsx's own shape, since the lifecycle is identical by design"*. Four independent copies of one shape is the strongest argument this schema will get. A row action **is** an `action` — same permission gate, question beside the row — so nothing new is invented for the destructive half. `file` and `graph` each have exactly one user, which is this schema's own bar for **no**, so both are deferred to the task where their only user is the evidence (M6-6, M6-7) rather than granted on the strength of sounding useful. |
| 2026-08-29 | **D82** — **every state-changing route is guarded or declared safe, and it joins `pnpm check` rather than the ten.** M6-1. `serve.ts` has twelve `POST` handlers and no rule about which of them can destroy something. The predecessor solved this — refuse without an explicit `confirm`, or be in a list with a written reason, and a test that walks **the real routes** rather than a list copied beside them — and then left a note about the hole in its own answer: the safe-list was keyed by `(path, method)` globally, so one router's harmless `/approve` would silently wave through another's destructive one. **That cannot reproduce here** — core's router is one flat match on `url.pathname`, so paths are already unique — which is worth recording now in case the router is ever split. **Deliberately not an eleventh invariant.** The ten are about the plugin contract, what survives a folder being deleted; this is a safety property of core's own HTTP surface, and inflating a named set to hold an unrelated member would cost more than it buys. |
| 2026-08-29 | **D81** — **the control surface exists, and its tab list is generated.** M6, inserted with a working predecessor as the evidence: `alexia control`, the first Alexia's Python dashboard, still running on this machine on `127.0.0.1:8771`, which shipped nine panels over 237 commits and found out which ones a person opens. The chat window answers *talk to it* and the settings pane answers *configure one plugin*; neither answers the day-thirty questions — **what has this been doing, what did I say yes to, what does it know, which of these did I install** — because those are records you read, not values you change. **Four of the seven panels do not belong to core**: memory, voice and commitments are plugins, and the predecessor listed all nine by hand in one `App.tsx` with a 480-line panel for a single text-to-speech vendor sitting in the dashboard's own source tree. That is this project's founding complaint arriving by the back door — not a feature you cannot remove, but a feature core cannot stop naming — so core contributes only the tabs whose data core owns, every other tab is declared by a plugin, and **M6-G is the same test as M0-G one screen further in**: delete `plugins/memory` mid-session and its tab goes with it. Three things came across unchanged because they were right the first time: read-only unless this screen is the sole owner, poll and never watch, and a broken module must not stop the app *or* print a plausible-looking success. |
| 2026-08-28 | **D80** — **the desktop app runs, and building it found two bugs nothing else could.** M5-1 through M5-5. Rust is 135 lines of the 300 the budget allows and does four things: picks a free port, spawns the core sidecar on it, points two windows at it, and owns the tray, the hotkey, autostart and single-instance. **The port is chosen in Rust rather than read back from the sidecar**, which is what lets the windows be built before Node has finished booting; the race that buys is smaller than the blank window that parsing stdout would cost. The page is a *remote origin* from Tauri's side because core serves it, so `withGlobalTauri` plus a capability listing `http://127.0.0.1:*` is how Escape and the tray tooltip get across — and the capability is the whole of what that buys: hide a window, set a tooltip, toggle autostart. **Two bugs came out of actually running it.** `resources/*` copies files and not directories, so `ui/` and `plugins/` were silently missing from the bundle; and core's shell lookup walked *up* from the bundle and found `src-tauri/ui` — Tauri's placeholder frontend — before the real one, so the window came up on a page whose own comment said a window had been built with the wrong URL. True and useless. The folder is now called `placeholder`, and the packaged layout is checked first, because two names that cannot collide beat a rule about which wins. Verified running: the real shell served, the token injected, all four modules 200, `/api/state` and `/api/plugins` answering, core resident at 65 MB. |
| 2026-08-28 | **D79** — **the four cold-install gates are deferred by the owner, not passed.** The instruction was to build the whole app and tune afterwards, so M2-8, M3-8 and M5-6 are unticked and stay unticked: nobody has been sat in front of this with a stopwatch, and a tick would be a lie about the one measurement the entire product claim rests on. What exists instead is everything they would measure — a signed-installer workflow that has never been run, an NSIS bundle that has, and a first run whose five steps are all on screen. M3-G is left too: *someone who is not you builds a working plugin from the docs alone* needs a someone. |
| 2026-08-28 | **D78** — **channels: do not formalise.** M4-8, revisited at n=3 with the evidence Alexia.md asked for. The three surfaces do not share the thing an abstraction would have to unify: **who owns the conversation, and where a permission question goes.** Core's shell owns a session and can stop and ask; Telegram owns its own store and deliberately has *no* agent loop, because on a phone chat the honest answer to *where does the permission prompt appear* is **nowhere** — so that surface gets `sampling` and no tools rather than a shared abstraction with a hole in it; and voice turns out not to be a channel at all, it is a capability core calls. A `channel` type would have had to paper over exactly the difference that matters. The cost of waiting is a little duplicated plumbing; the cost of guessing wrong is a permanent tax on every plugin. **What did generalise was named instead** — see D77. |
| 2026-08-28 | **D77** — **M4 broke the contract exactly once, and lazy spawn was the crack.** Lazy spawn assumes every plugin is something core *calls into*: quiet for five minutes and the process exits, the next call brings it back. The first plugin where messages arrive from **outside** proved that false — a chat bridge holding a long poll is not idle when nobody has typed at it for an hour, it is working, and stopping it is the same as switching it off. So `lifetime: "resident"`, one additive field, `alexia_protocol` 2, and **invariant 9 narrowed rather than dropped**: a plugin that has not declared it still runs no process, and the check now proves both halves and prints the list so a new name in it shows up in a diff. It is opt-in because it costs memory forever. This is what M4 was for — the contract cracking somewhere a real plugin pushed on it, before anyone else depended on the shape. |
| 2026-08-28 | **D76.5** — **conformance's own first failure was its error message.** *"it did not start: Connection closed"*, with the plugin's last words thrown away because stderr was attached only after a successful connect. The pipe still holds them, so it is read out either way now — and the first thing it said was `MODULE_NOT_FOUND`, because a relative folder path handed to `entry.args` resolves against the *child's* working directory, which is its own data folder and not this one. A checker whose failure sends an author looking in the wrong place is worse than no checker. |
| 2026-08-28 | **D76** — **`stop()` did not wait for the plugin core had already forgotten, and invariant 2 had been red for two milestones.** A resume found `pnpm check` red: `tooling.test.ts`, in teardown, `EPERM` deleting its own data directory. Underneath it, `load()` drops a vanished plugin and stops it in the same breath without awaiting — right, because noticing a deletion runs at the speed of the filesystem — and `stop()` then had nothing left to wait *for*, so it resolved with that process still alive. **Forgotten is exactly why nothing else would ever stop it**, which makes it an orphan outliving Alexia and holding a working directory inside the data folder a purge has to be able to empty. Reproduced deterministically before the fix and after: pid alive, then not. The fix is a `#leaving` set awaited by `stop()` and by `purge()` — purge had the same hole on its worst path, a folder deleted by hand before the delete button, where `entry` is undefined and the wait is for nothing. `shutdown.test.ts` fails without it. **The second finding is the bigger one.** Simulating the `no-plugins` job locally showed it red: `replan`, `skills`, `stop` and `tooling` use the repo's own plugins as fixtures and never joined `needPlugins` in `vitest.config.ts`, so invariant 2 — *core passes its full suite with `plugins/` empty* — has been failing since M15, and nothing local said so because `pnpm check` runs with `plugins/` present. `pnpm check:no-plugins` now moves the folder aside and restores it whatever happens, including on Ctrl-C, and was itself verified by making it go red. |
| 2026-08-28 | **D75** — **the packaged app had never once reached the credential locker, and only running it found out.** M2-7. Three bugs, all in the same place and all silent. `@napi-rs/keyring` opens with `createRequire(__filename)` — free in CommonJS, **undefined in an ESM bundle** — so the import threw and `cross-keychain` read that as *this backend is not supported here*; the PowerShell fallback it chose instead had its script left out of the package, so behind the silent failure was nothing at all; and `NAPI_RS_NATIVE_LIBRARY_PATH`, which M1-I1 set in good faith because it is checked first, is **broken upstream in 1.3.0** — the loader assigns what it loads to an inner variable and returns nothing while its caller writes that return over the same variable, so setting it took the branch that works out of reach. One banner, one copied file, one deleted line. What this says about the project is the part worth keeping: **a packaged build is the one artefact nothing else here exercises**, so `pnpm package` now starts what it just built and asks it for `/api/plugins` — manifests, the store and the keychain, the whole of what a fresh install touches before anybody types anything. The package also carries `hello` and `voice`, bundled, because M2-5 installs from a folder somebody points at and an app with no folder to point at makes *install → talk → delete* something you can only do with a checkout. The other platforms are answered with a decision: three small changes away, and not claimed until a machine has run one. |
| 2026-08-28 | **D74** — **progress reaches the trace, and it cost one optional argument.** M2-6. A plugin's `notifications/progress` now travels plugin → `Tooling.call` → an event on the running step → an SSE frame → a bar in the trace row that is already on screen. M2-1 had carried it to the settings screen; this is the route through the agent loop, which is where the work a person actually waits on happens. The plumbing is a fourth optional parameter on `Tooling.call` and nothing else: a `Tooling` that ignores it is still one, because a function of three parameters is assignable to one of four, so no fake in any test had to change. Two rules the building settled: **asking for progress is what creates the `progressToken`**, so a plugin that reports has somewhere to send it and one that does not never sends one — a caller never has to tell *no progress* from *no tool*; and **the bar appears when there is something to say and goes when the work does**, because one always present at zero is not believed when it moves and one left at 97% is worse than none. Verified by sampling the live shell every half second through a six-second tool call. |
| 2026-08-28 | **D73** — **a folder appearing is not consent, so a plugin now arrives installed and not enabled.** M2-5. The lifecycle's four arrows are real and persisted, and the line that turned out to matter is the first one: files on disk is *installed*, and **nothing runs on the strength of a folder appearing** — somebody reads what it asked for, in its author's own words, and says yes. That made *enable* the moment the namespace exists, so `store.create` moved out of `load`: an installed-but-not-enabled plugin owns no tables, no process, no routing and no `action` button, and its bundled skills wait with it. **Disable keeps every last thing delete would take**, which is the whole argument for it being the action the screen offers first; delete sits behind a second press that has already said what goes. Install is crude on purpose — a folder somebody points at, validated where it stands and copied second so a folder that is not a plugin never reaches the directory core watches — because browsing a library is M3-2 and until there is a registry there is nowhere else for a plugin to come from. The answer survives a restart as one `kv` row, and purge takes it, so re-installing starts at the walkthrough rather than at a yes given to a different copy. Six tests had to start saying yes, which is the check working: invariant 5's comment had claimed *install and enable* while only ever installing, and it now proves there is nothing in the database between the two. |
| 2026-08-28 | **D72** — **Alexia speaks, and the proof is that she can hear herself.** M2-4. `voice.speak` is *text in, audio played, nothing out*: Piper makes a WAV inside the plugin process and the operating system's own player plays it — no audio library, and a missing player fails with a sentence naming it. Verified by round trip: Piper said a line, `voice.transcribe` read it back one word off, and neither call named a plugin. **Hearing and speaking are two downloads and two bindings that move independently** — transcribing does not fetch a voice, speaking does not fetch a speech model, and `●` on the status line is reserved for both being ready, because halfway is a state the person watching has to be able to see. `speak` declares no `readOnlyHint`, for the same reason `listen` does not: making a noise in somebody's room is not read-only in any sense a person cares about. **Kokoro is deliberately not here.** It is the named quality upgrade and it costs an ONNX runtime plus a phonemizer in this plugin — exactly the dependency shape the whole thing has avoided, and which Piper ships inside its own 22 MB. The upgrade that costs nothing today is the voice choice; a real Kokoro option belongs at M4-6, where an ONNX runtime is already being paid for. |
| 2026-08-28 | **D71** — **voice works, and the capability binding earns its design on the first real plugin.** M2-3. `plugins/voice` fetches a pinned whisper.cpp build and a model with progress the whole way, spawns `whisper-cli` on a file and `whisper-stream` on the microphone, and puts **only text** on the wire — which is not a policy, it is where the code runs. Before the download, `voice.transcribe` is declared in the manifest and bound on no tool, so a caller gets `-32050`; after it, the binding appears and the capability answers. That is D59 happening rather than being described, and it was verified in that order. Three decisions worth keeping: **`listen` declares no `readOnlyHint`**, because read-only is true about the disk and wrong about the room, and an undeclared tool is one the gate stops on; **`whisper_path` is the tenth widget's first honest use** and also the whole non-Windows story; and **Windows' own `tar` is named explicitly**, because what is on `PATH` may be GNU tar, which cannot read zip and reads a drive letter as a hostname. Two bugs came out of it that were nothing to do with voice: **every invariant check had been reading past every first-party plugin** — the globs matched `.ts` and the plugins are JavaScript — and the first thing the widened check caught was an overclaiming sentence of mine. Purge was measured: 169 MB in, zero left. |
| 2026-08-28 | **D70** — **skills load, and the index is a tool description rather than a system line.** M2-2. One `skill` tool carries every installed skill's `name` and `description` in its own description — which is where a model looks when it is choosing what to reach for — and its body arrives only when the model calls it, a file under it only when it passes `file`. All three of agentskills.io's disclosure levels, and **`agent.ts` did not change at all**. Two rules were worth the extra lines: reading a skill declares `readOnlyHint` through the gate's existing `about()`, or the default permission mode would ask the user before the model could open its own instructions; and a folder that fails to load is shown with the reason, because *a skill that is not firing and is not visibly broken is the hardest thing in this system to debug*. Six ways to be broken are named, including one the spec did not — **two skills answering to one name**, which is a problem said out loud rather than a silent winner. A bundled skill goes when its plugin does through no code of its own: `name` and `description` are re-read from disk, so there is no index to fall out of step. `plugins/hello` now bundles one, so the bundled route is proved against a real plugin. |
| 2026-08-28 | **D69** — **no secret has ever actually been stored.** `cross-keychain` refuses an account name containing a slash, and `secrets.ts` had been building `<plugin>/<key>` since M1-3 — so every keychain read and write threw, in both directions, on any real machine. That includes the provider key a person pastes at first run, which means the one step first run exists for could not have worked. Nothing caught it because every test uses `memorySecrets`, which has no such rule; the first thing to touch the real store was M2-1's settings screen. The separator is now a dot, which is legal and still unambiguous — a plugin id cannot contain one and neither can a setting key — and `account()` is exported so a test can pin the format, because the constraint lives outside this repo and will not announce itself if it changes. |
| 2026-08-28 | **D68** — **the ten widgets are rendered, and the `alexia/*` layer gained its sixth method to make one of them true.** M2-1. Core renders from the manifest and spawns nothing to do it, which is the whole reason the schema lives in `plugin.json`. `ui-schema.md` had promised that a `status` is driven by the plugin *writing to its own settings value* and **no method could write one** — so `alexia/settings/set` exists, and writes **only the caller's own `status` keys**: a plugin that could rewrite a `toggle` the user set could quietly undo a person's decision, and would have to be trusted rather than read. Two of core's decisions stay core's: two or three options is a segmented control and four is a dropdown, and an `action` goes through the same permission gate as any other tool call — asked beside the button, where the thing being decided is. A `password` is never rendered, only reported as set, with core's own sentence naming the store. `plugins/hello` grew to nine widgets and drives three of them, so the screen is proved against a real plugin rather than a fixture. |
| 2026-08-28 | **D67** — **the visual language is written down, and both themes are a test.** `docs/design.md` is the deliverable M2-1's ten widgets conform to; `app.css` is rewritten from its tokens with no literal sizes, spaces or colours left. The header now distinguishes a control from a status from the number that matters, instead of rendering all three as identical pills. **First run is a view**, not a section — `data-view` swaps it and the composer is not rendered on it, so *never on screen together* is a fact about the DOM rather than a rule to remember — and the header is hidden there too, because it was drawing the mark and the name a second time sixty pixels below the first. Light and dark are built for their own grounds and held at 4.5:1 by `packages/ui/test/contrast.test.ts`, which reads `app.css` rather than keeping a second copy of the palette. Verified by driving headless Edge over CDP: nothing scrolls at 1280×800, and every focused element shows a ring under real key events. Two bugs found that way — a blanket `width: 100%` was making the header's dropdowns 1233px wide and pushing the spend off screen, and the first-run question's size was being set and then un-set by a later, equally specific rule. |
| 2026-08-28 | **D66** — **M2-S1 answered: the Tauri overlay holds, and no workaround is needed.** 200 show/hide cycles on Tauri 2.11.5 / Windows 11, twice, with `WS_EX_TOPMOST` read off the `HWND` rather than taken from `is_always_on_top()` — the reported bug is the framework and the OS disagreeing, so the framework cannot be the witness. Tray and hotkey verified the same way, from outside the process. The real finding is the one failure that was not `alwaysOnTop`: **a blur in flight can hide the overlay a moment after the `show()` that was meant to open it.** Harmless in the harness once stragglers are attributed correctly; not harmless in the product, because *click away, change your mind, press the hotkey* is exactly that sequence — so **M5-2 owes blur-to-hide a guard against a blur older than the show it cancels**. Also banked for M5-1: `tauri-build` fails rather than skips without an `.ico`, and the global-shortcut plugin's error does not convert into `tauri::Error`. |
| 2026-08-28 | **D65** — **the crude installer is pulled forward from M2-7 to M1-I1.** `pnpm package` builds `dist-app/Alexia/`: bundled core, a copied `node.exe`, the shell and the one native dependency, behind an `Alexia.cmd` that runs from wherever it was unzipped. It was built for cold-install test #1, which D64 then waived — so it is recorded for what it is rather than for the gate it missed, because **M2-8 cannot start its clock without it**. Neither `@yao-pkg/pkg` nor NSIS was needed; esbuild and a copy were. Windows only for now, which is what M2-7 keeps. Smoke-testing the packaged bundle also found a core bug and fixed it: the request target was resolved *against* an origin, so a leading `//` was protocol-relative — every path answered with the shell, and a bare `//` was a 500. |
| 2026-08-28 | **D64** — **cold-install test #1 is waived, not passed.** Owner's call, taken to get on with the product: M1-13's box is ticked so M2 can start, and the human half of it — a tester, a clock, no help — rolls into **M2-8**, where an installer exists and the protocol's stopwatch can start where it is meant to. The cost is named rather than hidden: no M1 row in the four-test trend, and `test/cold-install/results.md` carries a note saying test #1 did not happen instead of a fabricated row. **M1-G** is ticked in the same breath, carried by M15-G — a multi-step task on a free local model, spend 0.00, with the 429 fallback and the pin refusal held by `router.test.ts` rather than by a second sit-down. Both notes live in the task blocks so the tick is never read as a pass. |
| 2026-08-27 | **D63** — the never-touch list has **no exceptions**, Full trust included. Alexia.md contradicted itself four lines apart and this file sided with the wrong half; both are corrected. Full trust removes prompts, not the floor. Also settled while building M15-3: paths are matched by segment rather than by string prefix, `pathsIn` reads absolute paths only and says why that limit is honest rather than pretending to be a sandbox, and a spoken boundary is quoted back verbatim and holds in every mode — including Full trust, because it is the user's own instruction and not a setting. |
| 2026-08-27 | **D62** — **G5 answered: yes.** A 7–9B local model can genuinely plan, so `hard` work no longer skips this machine and Local mode is a real agent rather than a chat window. Two changes, not the one the plan expected: the shape-to-tier table went uniform and was deleted — a lookup returning the same answer for every key is drift with a type annotation — and `PLANNER`, a 7B floor in parameters, took over the job `tier` could not do, since every local model is `T0` at any size. Consequence worth stating: per-step tiering now bites in **Local** mode, where the plan runs on the 8B and the crank steps run on whatever else can call a tool. In cloud mode every step was already going cheapest-first, so there was never a saving there to find. |
| 2026-08-27 | **D61** — the design pass is **deferred to M2-D1**, before the widgets that inherit it and after the features. D60's finding held; its sequencing did not. `docs/design.md` exists to be spent by M2-1, so M2-1 is its deadline, and a first cold-install test learns more about *what a person does when told to go and make an OpenRouter account* than about the frame around it. M1-D1 shrank to a holding theme — one dark achromatic palette, her face as icon and mark, a visible focus ring — and to the two structural bugs that were not taste: `form.hidden` defeated by a type selector, and the third mode card wrapping under the fold. |
| 2026-08-27 | **D60** — the plan had no design task. M5-5's *"polished"* turns out to mean the flow and its timings, not the look, and M2-1's *"every plugin matches the theme"* names a theme nothing creates. Added **M1-D1**, before the first cold-install test: a restructure of the shell, plus a written `docs/design.md` for M2-1's widgets and M15-5's trace to inherit. Trust is not decoration in a product that asks for a key, a folder and a budget. |
| 2026-08-27 | M1-1: the database file is `alexia.db` under the **local** app-data directory on Windows, not the roaming one. Roaming profiles sync on logoff, and a synced live SQLite file with a WAL beside it is how histories get corrupted. Schema versioning is `PRAGMA user_version` with a forward-only migration list; a database from a newer build is refused rather than opened. |
| 2026-08-27 | **D59** — a capability is **declared** in the manifest and **bound** on the tool, in MCP's own `_meta` as `alexia/provides`. The manifest is what the library shows and what another plugin's `requires` resolves against before anything is running; the tool is what says it can answer *right now*. A plugin whose model has not downloaded cannot answer `voice.transcribe` and should not claim it can. |
| 2026-08-27 | **D58** — a plugin's working directory is **not** its folder. Windows will not delete a directory that is a running process's cwd, and that is exactly the demo the project exists for. Measured both ways; core spawns with the cwd on a directory it owns and hands the folder over as `ALEXIA_PLUGIN_DIR`. |
| 2026-08-27 | M0-4 needed core to *answer* `alexia/*`, so the minimum store — `node:sqlite`, namespaced tables, kv, settings, purge — landed here rather than at M1-1. M1-1 adds migrations, the platform data directory and the transaction helper; M1-3 adds the keychain. The wire contract and the namespace rule are what M0 has to prove, and both are now under test. |
| 2026-08-27 | **D57** — an Alexia plugin speaks MCP `2025-11-25`, and `2026-07-28` is the revision core *also* accepts. That era removed the server-to-client request channel, and four of the five `alexia/*` methods are requests a plugin sends to core. Measured, not read: on the newer era they are dropped unanswered. The two-wide window still holds, pointing the other way. |
| 2026-08-27 | **D56** *(superseded by D57 in mechanism — it describes `2026-07-28`, which is not where Alexia plugins live)* — on `2026-07-28` a plugin never *sends* core a request: sampling, elicitation and roots come back in-band as an `input_required` answer to the call being served, and core re-sends the call with the answers. Found while building M0-2; the wire spec said `sampling/createMessage` and left an author to guess the direction. Sampling and roots are deprecated upstream (SEP-2577, ≥12 months) and Alexia keeps both — the advice to "call provider APIs directly" assumes a key the plugin must not have. Also: `execa` dropped from core, see the parts list. |
| 2026-08-27 | **D55** — MCP `2026-07-28` has no `initialize`: `server/discover`, a per-request `_meta` envelope, and `subscriptions/listen` for every server-to-client notification. G3 answered — core accepts the pinned revision and its immediate predecessor, two at a time. |
| 2026-08-27 | **D54** — the agent loop gets its own milestone, M1.5. It had none, and it is the product. |
| 2026-08-27 | **D53** — Claude Code plugin: built, shipped disabled, never auto-enabled, user runs `setup-token` themselves. Written confirmation from Anthropic before any public release enables it. |
| 2026-08-27 | **D52** — autonomy: Claude Code runs a whole milestone, stopping at gates, irreversible actions and blocks. |
| 2026-08-27 | **D51** — free means free by layering: pool the free tiers (M1-6, moved forward), route mechanical steps to T0, say the optional $10 out loud. Catalog gains `trains_on_your_data`. |
| 2026-08-27 | **D50** — the wire protocol is MCP, pinned, with a five-method `alexia/*` layer for what MCP does not cover. The plugin marketplace starts non-empty, the same way agentskills.io made the skills one start non-empty. |
| 2026-08-27 | plan.md written. |
