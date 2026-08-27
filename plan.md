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

- [ ] **M1-1** Storage: SQLite, migrations, per-plugin namespaces
- [ ] **M1-2** Sessions and message history
- [ ] **M1-3** Settings store and `SecretStore`
- [ ] **M1-4** Provider layer — one OpenAI-compatible interface
- [ ] **M1-5** Model catalog: fetch, cache, daily diff, honesty flags
- [ ] **M1-6** Free-tier pool adapter (self-hosted)
- [ ] **M1-7** Ollama provider (T0)
- [ ] **M1-8** The router — tiers, three axes, pins, 429 fallback
- [ ] **M1-9** Usage, attribution and caps
- [ ] **M1-10** Chat shell
- [ ] **M1-11** First-run flow v1
- [ ] **M1-12** Slash commands
- [ ] **M1-13** `[GATE]` Cold-install test #1
- [ ] **M1-G** **Done when:** a real conversation, routed to a free model, spend showing 0.00

### M1.5 — The loop and its rails *(inserted 2026-08-27 — see Change log)*

- [ ] **M15-1** The agent loop
- [ ] **M15-2** Plugin tools reach the model
- [ ] **M15-3** Permission modes and the never-touch list
- [ ] **M15-4** The safety checker
- [ ] **M15-5** The visible trace and the stop control
- [ ] **M15-6** Step-trace trimming
- [ ] **M15-7** Ceilings and the spend preview
- [ ] **M15-8** A tool vanishes mid-task
- [ ] **M15-G** **Done when:** a multi-step task finishes on a free model, every step visible, stop works mid-step

### M2 — Voice, the real proof

- [ ] **M2-S1** Spike: Tauri tray + hotkey + overlay on Windows *(de-risking M5)*
- [ ] **M2-1** Declarative UI schema v1
- [ ] **M2-2** Skills loader (agentskills.io)
- [ ] **M2-3** `plugins/voice` — speech to text
- [ ] **M2-4** `plugins/voice` — text to speech
- [ ] **M2-5** Full lifecycle: install, enable, disable, purge
- [ ] **M2-6** Streaming progress over the wire
- [ ] **M2-7** The crude installer
- [ ] **M2-8** `[GATE]` Cold-install test #2
- [ ] **M2-G** **Done when:** install → talk → delete leaves no residue and not one line changed in core

### M3 — The plugin library

- [ ] **M3-1** Registry backend
- [ ] **M3-2** Registry client and library UI
- [ ] **M3-3** The conformance suite
- [ ] **M3-4** Author docs and the scaffold command
- [ ] **M3-5** The skills marketplace
- [ ] **M3-6** MCP compatibility mode
- [ ] **M3-7** Checksums and signing
- [ ] **M3-8** `[GATE]` Cold-install test #3
- [ ] **M3-G** `[GATE]` **Done when:** someone who is not you builds a working plugin from the docs alone

### M4 — Contract generality

- [ ] **M4-1** `plugins/telegram`
- [ ] **M4-2** `plugins/computer` — computer control
- [ ] **M4-3** `plugins/memory` — long-term recall
- [ ] **M4-4** `plugins/persona` — the personality node
- [ ] **M4-5** Learned skills
- [ ] **M4-6** Local media generation
- [ ] **M4-7** `plugins/claude-code`
- [ ] **M4-8** Channels: formalise or do not
- [ ] **M4-9** Contract freeze v1
- [ ] **M4-G** **Done when:** voice, Telegram and computer control all work with no special-casing in core

### M5 — The app

- [ ] **M5-1** The Tauri shell
- [ ] **M5-2** Tray, hotkey, overlay, autostart
- [ ] **M5-3** `[GATE]` The signed installer
- [ ] **M5-4** Automatic updates
- [ ] **M5-5** First run, final
- [ ] **M5-6** `[GATE]` Cold-install test #4 — the real one
- [ ] **M5-G** `[GATE]` **Done when:** a non-technical tester installs cold and reaches a working conversation, never seeing a terminal

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
      ui-schema.md          # the ten widgets
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

### M1-13 `[GATE]` Cold-install test #1

The first real one. Follow `docs/cold-install.md` exactly. Do not help. Append to
`test/cold-install/results.md`.

Not because the product is ready — it is a dev build with no installer — but because *where
someone hesitates* is cheap information at M1 and expensive at M5.

### M1-G — Done when

> **You hold a real conversation, routed to a free model, with spend showing 0.00.**

Plus: the router demonstrably falls back on a 429 rather than failing, and refuses to violate
a pin. **Stop here and report.**

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
system directories, Alexia's own config. It is not overridden by any mode except explicit
Full trust. This list is deterministic code — it is what stands between the user and a
disaster when the checker is wrong.

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

### M2-1 Declarative UI schema v1

The ten widgets, **driven by what voice actually needs** rather than guesses. Core renders;
the plugin never draws. A plugin cannot style itself wrong because it never styles itself.

Settings must render while the plugin process is **not running** — lazy spawn means that is
the normal case. That is why the schema lives in the manifest.

### M2-2 Skills loader

agentskills.io, per P0-5. Scan skill folders, parse frontmatter with `gray-matter`, index
`name` + `description` only (~100 tokens each), load the body on match, load `references/` on
demand. A hundred installed skills cost nothing until one is relevant — which is what makes
an unbounded library practical rather than a context problem.

Two arrival routes: bundled with a plugin (installs and purges with it) or installed
standalone. Purge handles both; the marketplace never shows a bundled skill as independently
installable.

### M2-3 Voice — speech to text

`whisper.cpp` binary, spawned by the plugin process. **The plugin captures the microphone
itself and sends only text to core.** No audio crosses the boundary — that is the privacy
property process isolation was bought for, and it is the first time it is visible.

Model download over `notifications/progress`, because a 1.5 GB download with no feedback is
indistinguishable from a hang.

### M2-4 Voice — text to speech

Piper by default; Kokoro as the quality upgrade. Registers `voice.speak`.

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

### M2-6 Streaming progress

`notifications/progress` end to end, from the plugin through core to a progress bar that
never goes silent. Silence is what kills a first run, not time.

### M2-7 The crude installer

Not signed, not pretty, no auto-update. Something your test person can double-click.

It exists to answer one question at every milestone from here: **how long did that actually
take, and where did they stop?** The demo lives at M5 and M5 is last; without this, the claim
the whole product rests on cannot be measured until the end.

`@yao-pkg/pkg` for the core binary, a minimal Tauri wrapper or a plain NSIS script for the
double-click. Ugly is fine. Silent is not.

### M2-8 `[GATE]` Cold-install test #2

The first one with an installer. Time it. Compare against #1.

### M2-G — Done when

> **Install → talk → delete leaves no residue on disk and not one line changed in core.**

`git diff` across M2 shows zero changes under `packages/core/src` attributable to voice.
**Stop here and report.**

---

## M3 — The plugin library

Registry, review, docs, conformance. Alexia.md's risk 5 is honest that this is where scope
grew; the ordering below reflects that the conformance suite is the load-bearing part.

### M3-1 Registry backend

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

---

## M5 — The app

The demo, finally shipped. Everything before this has been measuring the claim; this is where
it becomes true.

### M5-1 The Tauri shell

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

---

## Gates that need you

Every `[GATE]` in one place, so none is a surprise.

| Gate | What it needs from you |
|---|---|
| **P0-1** | Approve making the repo public, and the first push |
| **M1-13** | Sit the tester down. Time them. Do not help. |
| **M2-8** | Same, with an installer |
| **M3-8** | Same |
| **M3-G** | Someone who is not you writes a plugin from the docs |
| **M3-G+** | Approve opening the registry to third-party submissions |
| **M4-7** | Ask Anthropic about the Claude Code integration, in writing |
| **M5-3** | Apply to SignPath Foundation; approve publishing a signed binary |
| **M5-6** | The real cold-install test |
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
- **G6.** What happens to the free-tier pool when a provider changes its terms mid-release?
  A kill switch for provider entries, the same way the registry has one for plugins?
  *Decide at M1-6.*

---

## Change log

Newest first. Every entry here is also in Alexia.md's decision log.

| Date | Entry |
|---|---|
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
