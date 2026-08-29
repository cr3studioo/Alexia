# Alexia — open questions

> Working list. Answered questions get written into [`Alexia.md`](./Alexia.md) and marked
> `[x]` here with a pointer to where the answer landed. New questions get added as answers
> reveal them; questions that become irrelevant get struck out rather than deleted, so the
> reasoning stays visible.
>
> **Status key:** `[ ]` open · `[x]` answered · `[~]` partly answered, needs follow-up ·
> `[-]` dropped (no longer relevant)

**Progress: 49 / 49 from the design round answered. Six new questions (G1–G6) came out of
planning the build on 2026-08-27; each is attached to the task that will answer it, and none
of them blocks starting.**

---

## A. Vision and product shape

- [x] **A1.** Is *Alexia* the final name, and is it also the wake word?
  **Answered 2026-08-27:** yes to both, plus first run asks *"what do you want to call me?"*
  and the user's answer becomes the visible name. Display name is data, never code.
  Landed in *What the user calls it*.
- [x] **A2.** What is the demo?
  **Answered 2026-08-27:** installed and working in under two minutes. Setup is the pitch,
  not the agent loop. Landed in *Who this is for* — and it pulled a rough installer forward
  to M2 so the claim is measurable.
- [x] **A3.** How do you reach Alexia?
  **Answered 2026-08-27:** global hotkey overlay locally, plus Telegram. Makes Alexia a
  tray-resident daemon with thin UI faces. Landed in *Access surfaces*.
- [x] **A4.** Does Alexia keep working on its own after you hit enter?
  **Answered 2026-08-27:** yes — agentic, plans and loops until done. Landed in
  *The agent loop*, along with the cost tension it creates.
- [x] **A5.** What is the privacy promise?
  **Answered 2026-08-27:** the user picks at first run, both modes can be enabled at once,
  and you switch at runtime with commands (`/local`, `/nsfw`). Generalised into three
  router axes — cost, privacy, content policy. Landed in *Privacy modes and the command
  surface*.
- [x] **A6.** Is *channel* a first-class concept?
  **Answered 2026-08-27:** wait for the third surface. Telegram is an ordinary plugin;
  formalise at M4 if a third one appears. Landed in *Access surfaces*.
- [x] **A7.** Telegram auth and the privacy contradiction.
  **Answered 2026-08-27:** keep both modes with exact wording, and authenticate with a
  one-time pairing code shown in the desktop UI that allowlists your Telegram user ID.
- [x] **A8.** Renaming scope.
  **Answered 2026-08-27:** display name now, wake word later.

## B. The user and the first five minutes

- [x] **B1.** Who is the non-technical user?
  **Answered 2026-08-27:** a specific person known to you. Commitment recorded: cold-install
  test at every milestone, timed, without helping.
- [x] **B2.** Setup ceiling?
  **Answered 2026-08-27:** five minutes, with a download acceptable if progress is always
  visible. The two-minute demo claim belongs to Combined mode, which has no download.
- [x] **B3.** Is a zero-key path required?
  **Answered 2026-08-27 by C9:** yes. Agent mode must work with no paid key at all, on
  local models. Landed in *Privacy modes*.
- [x] **B4.** The first-run flow.
  **Answered 2026-08-27:** drafted from every other decision rather than asked in the
  abstract. Landed in *First run, end to end* — five steps, no account, no tour, no permission
  questions, under two minutes in Combined mode.

## C. What core actually does

- [x] **C1.** Is provider integration core or a plugin?
  **Answered 2026-08-27:** core. Raised the cost once (each provider becomes a core
  release, and it sits oddly beside Claude Code being a plugin); reaffirmed. Recorded as a
  deliberate exception, bounded by writing core against one OpenAI-compatible interface.
- [x] **C2.** Which providers at launch?
  **Answered 2026-08-27:** OpenRouter, Ollama, direct keys, local image/audio generation,
  plus Claude Code as a plugin. Free-tier aggregation gets our own self-hosted adapter
  rather than a dependency. Landed in *Model providers*.
- [x] **C3.** Where does memory live?
  **Answered 2026-08-27:** sessions and step trace in core, long-term recall as a plugin.
  Landed in *Memory*. Raised C12.
- [x] **C4.** Can plugins register tools the model can call?
  **Answered 2026-08-27 by A4:** yes — going agentic makes plugins into tools by
  definition. The manifest gains a `tools` block. Landed in *The agent loop*.
  *Still open within it:* whether plugins can also inject into the system prompt (see C5).
- [x] **C5.** What does "whatever you want it to be" mean?
  **Answered 2026-08-27 — I had misread it.** It means *capability*, not personality:
  Alexia can do anything you throw at it, via plugins **and skills** from marketplaces.
  A default persona ships pre-installed and personas are switchable. Landed in
  *What Alexia is* and *Skills*.
- [x] **C6.** How far does the command surface go?
  **Answered 2026-08-27:** Alexia suggests switches herself rather than waiting to be told,
  and plugins register their own commands via the manifest so deleting the folder removes
  them. Collision rule still to pick (noted in E11).
- [x] **C7.** Does the agent loop live in core?
  **Confirmed 2026-08-27:** yes, and it is named in the doc as the one real exception to
  the plugin thesis. Landed in *The agent loop*.
- [x] **C8.** Agent rails and the permission model.
  **Answered 2026-08-27:** modelled on Claude Code, verified against its docs. Mode and
  folder scope are visible; rules come from plugin manifests plus a fixed never-touch list
  and stay invisible. A safety checker runs on a local model by default, with Claude Code
  or a cloud model as alternatives. Landed in *Permissions and the safety checker*.
  **Still open:** default step and spend ceilings for a single task — see C11.
- [x] **C9.** Agent cost policy.
  **Answered 2026-08-27:** agent mode must work with no paid key at all. Three persistent
  modes — Local, Combined, Cloud — with Combined splitting by capability class rather than
  by cost. Landed in *Privacy modes and the command surface*.
- [x] **C10.** Claude Code integration details.
  **Answered 2026-08-27:** `claude setup-token` for auth; detect a missing binary at enable
  time and say so plainly. The usage-terms check is now a **to-do before the first public
  release**, not an open question.
- [x] **C11.** Default ceilings for one agent task.
  **Answered 2026-08-27:** long leash — high ceilings, mostly runs free. Logged as risk 4,
  since it compounds with AI-written code.
- [x] **C12.** How is the step trace trimmed?
  **Answered 2026-08-27:** recent steps verbatim, older summarised, raw tool output dropped
  once its lesson is recorded. Plus the much bigger idea it produced — **learned skills**,
  now its own subsection under *Skills*.

## D. Technical decisions

- [x] **D1.** Confirm or reject the stack.
  **Answered 2026-08-27:** confirmed — Tauri shell, TypeScript core, TypeScript SDK. Added
  the rule that Rust stays confined to installer, updates, tray and hotkey.
- [x] **D2.** Which OS does v1 target?
  **Answered 2026-08-27:** Windows first, portable by discipline. Landed in *Stack*.
- [x] **D3.** Transport.
  **Confirmed 2026-08-27:** JSON-RPC 2.0 over stdio. **Refined the same day (D50):** that is
  MCP, which already specifies it — pinned revision plus a five-method `alexia/*` layer for
  what MCP does not cover. Landed in *Architecture* and in `plan.md`, *The contract*.
- [x] **D4.** Storage.
  **Confirmed 2026-08-27:** SQLite, one file, namespace per plugin, in the platform's
  standard per-user app data location. Landed in *Storage*.
- [x] **D5.** Enforced or declared permissions?
  **Answered 2026-08-27:** declared and trusted, with the limitation stated plainly in the
  doc. OS enforcement stays possible later for filesystem and shell only. Landed in
  *Permissions and the safety checker*.
- [x] **D6.** Plugin UI.
  **Answered 2026-08-27:** declarative schema, core renders. Sandboxed frames remain
  available only for a genuine future exception.
- [x] **D7.** How do plugins update?
  **Answered 2026-08-27:** independently with a protocol version check; yours ship with the
  app. The handshake is what makes accepting plugins early survivable.

## E. Plugins and ecosystem

- [x] **E1.** Registry hosting.
  **Answered 2026-08-27:** a real backend, chosen for instant revocation. Keep it minimal —
  a list with a revoke button, not a product.
- [x] **E2.** Third-party plugins, and when.
  **Answered 2026-08-27:** accept early, review each one yourself. Conditional on the
  conformance suite existing first, and on stating up front that there is no promised
  review turnaround.
- [x] **E3.** Licence.
  **Answered 2026-08-27:** split — Apache-2.0 on the SDK and protocol, AGPL-3.0 on the app.
  Landed in *Licence*. Must be set before the first public push.
- [x] **E4.** What comes after voice?
  **Answered 2026-08-27:** Telegram, then computer control. M4 updated to stress-test those
  two shapes. Memory stays a plugin but is not part of the M4 set.
- [x] **E5.** Can a plugin ship skills?
  **Answered 2026-08-27:** yes, declared in the manifest, installing and purging with it.
- [x] **E6.** One marketplace or two?
  **Answered 2026-08-27:** two, with different review bars. Landed in *Skills*.
- [x] **E7.** What is a persona, mechanically?
  **Answered 2026-08-27:** a node that conversational output passes through, itself a plugin.
  Code, actions, permission requests, alerts and mode switches bypass it. Landed in *Skills*.
  Raised E10.
- [x] **E8.** Adopt agentskills.io?
  **Answered 2026-08-27:** yes. Still to do: read the spec properly and confirm it carries
  what Alexia needs.
- [x] **E9.** How is a wrong learned skill caught?
  **Answered 2026-08-27:** attribution when it fires, with *edit* and *forget* inline.
- [x] **C13.** What triggers the learned-skill offer?
  **Answered 2026-08-27:** the model judges whether the task was non-trivial, rather than a
  step count.
- [x] **E10.** Personality: rewrite or inject?
  **Answered 2026-08-27:** rewrite, but only when a non-default persona is active. Default
  Alexia streams normally with no extra call.
- [x] **E11.** Command collisions.
  **Answered 2026-08-27:** first installed wins the bare word; the second shows in amber with
  a one-click switch to `/voice.mute`. Core derives the namespaced form for every command
  automatically, so authors declare one name and resolving a collision never breaks a working
  command.

## G. Raised by planning the build (2026-08-27)

*Each of these came out of writing [`plan.md`](./plan.md). None blocks starting; each names
the task that closes it.*

- [ ] **G1.** Does the typed storage API cover a real plugin, or does the first join force a
  proper query layer? Alexia.md confirmed one SQLite file with a namespace per plugin, which
  means core must enforce the namespace without parsing arbitrary SQL. v1 is a typed API over
  manifest-declared tables plus a deliberately over-cautious raw escape hatch.
  *Decide at M2, with voice as the evidence.*
- [ ] **G2.** How does a plugin written in something other than JavaScript declare its runtime?
  Node comes bundled with Alexia and is therefore free to plugin authors — a real advantage
  worth naming. Python is not. Ship `uv`, require system Python, or keep the first-party set on
  Node? *Decide at M3, with the author docs.*
- [x] **G3.** Which MCP revision is pinned, and what is the policy for moving?
  **Answered 2026-08-27 at P0-3 (D55):** pin `2026-07-28`, and accept exactly two revisions
  at a time — the pinned one and its immediate predecessor, today `2025-11-25`. A new
  revision becomes the pin in a minor release; the old predecessor drops one release later;
  the registry warns affected authors first. Reading the pinned schema also corrected D50:
  `2026-07-28` has **no `initialize`** — `server/discover`, a per-request `_meta` envelope,
  and `subscriptions/listen` for every server-to-client notification. Landed in
  `docs/spec/wire-protocol.md` and in Alexia.md's decision log.
- [ ] **G4.** Does an MCP-compatibility-mode server appear in the plugin marketplace at all, or
  only behind an "add a server" affordance? Different review bars are the entire reason there
  are two marketplaces, and an unreviewed MCP server is a third category.
  *Decide at M3-6.*
- [ ] **G5.** Can a small local model actually *plan*, or only execute? Alexia.md flags this as
  worth testing rather than assuming, and the answer decides whether Local mode is a real agent
  or a chat window. Testable on this machine: a qwen3-class 7–9B at Q4, 8–16k context, on an
  8 GB card. **Test it at M15-1.**
- [ ] **G6.** What happens to the free-tier pool when a provider changes its terms mid-release?
  A kill switch for provider entries, the same way the registry has one for plugins?
  *Decide at M1-6.*

### Raised by planning the control surface (2026-08-29, M6)

- [x] **G7.** Is there an honest way to express *give me a file* in a schema whose whole point
  is that a plugin never draws? **Answered 2026-08-29 (D89): no, and the single user is why.**
  The 15-second clip was voice *cloning*, which belongs to the text-to-speech vendor refused at
  M2-4 — Piper does not clone from a recording. What voice actually wants is a Piper voice
  somebody already downloaded, so they have already been to the file and `path` is an equal
  first minute rather than a worse one. The structural half is kept for whoever asks next: a
  browser will not tell a page where a file is, so a `path` can never be filled by picking, and
  *choosing a file* is genuinely inexpressible in the schema. That argument is real and is
  waiting on a real user.
- [~] **G8.** Does a plugin ever get to draw something core cannot? **Answered 2026-08-29
  (D90): not yet, because the first real instance turned out not to be one — and reopened the
  same day (D97) now that the vault's links are authored, which is the condition D90 named.
  Nothing was built on the reopening: the refusal stands and now has something to be asked
  about.** `plugins/memory`
  stores flat sentences with a category, not a graph. The predecessor's graph was over an
  Obsidian vault where the links were *authored*; here they would have to be *inferred*, and a
  graph of inferred similarity is a picture that looks meaningful and is not — worse than no
  picture, because nobody can tell. The table ships with `groupBy`, which shows the structure
  this store actually has. **All three answers stay open** for whoever brings a plugin with
  real edges, and so does the recommendation: a hand-written force layout if it is genuinely
  small, otherwise the sandboxed iframe.

### Raised by reading version 1 (2026-08-29, M7)

*The first Alexia read end to end (D93). These four came out of the comparison; three of them
are still open, and the last one is the largest contract question left.*

- [x] **G9.** Does memory-that-captures-by-itself replace `plugins/memory`, or stand beside it
  as a second plugin? **Answered 2026-08-29 (D97): one plugin, and the contract decided it.**
  Not the balance of screens — a second plugin **cannot read the first's tables**, because that
  is the namespace rule rather than a preference, so *recall* would see half the memory and
  there would be two tabs called Memory with no way to join them. Running the cheap one only
  survives as a switch, which is one toggle rather than one folder. Invariant 5 holds: the two
  new tables are declared, so a purge takes them.
- [ ] **G10.** Voice cloning needs an engine Piper is not. Second plugin, or an engine setting
  inside `plugins/voice`? A second plugin keeps the local-only promise literally true and
  deletable; a setting keeps one voice screen and one place a voice is chosen.
  *Decide at M7-4 — where D89's refusal of `file` gets asked again with a user that needs it.*
- [x] **G11.** Is egress redaction core's rule, or a capability a plugin can ask past?
  **Answered 2026-08-29 (D94): core's rule, and a plugin cannot ask.** No capability, no
  manifest field, no setting. The bias going in was that *a redaction a plugin can decline is
  a redaction the worst plugin declines*; building it added the structural half — **a plugin
  never sees the outbound payload.** It hands core a tool result and core dispatches, so an
  opt-out would first mean inventing a way to ask for one, which is a new contract surface
  whose only purpose is to send more. The legitimate case is priced rather than denied: a
  plugin whose job is credentials or addresses gets them stripped on the way to a hosted
  model, and its answer is `T0`, where nothing is stripped because nothing leaves.
- [x] **G12.** **May a plugin run on its own clock, and spend on it?** **Answered 2026-08-29
  (D96): yes to the clock, and on it it spends nothing but free.** The ceiling is a **tier
  rather than a number**, because M15-7's spend preview is what makes an expensive run
  somebody's decision and a timer waking up has nobody to show it to. **Derived rather than
  declared**: the router reads *attributed to a plugin, belonging to no run* as *free only* —
  one rule, in the place M7-1 already put one, instead of a flag at every call site. M7-2's
  `run_id`, added the day before, is what made that sentence expressible. The checker keeps
  its paid path because it runs inside a task and carries that task's id. A real tightening —
  `sampling` could spend to the monthly cap before this. **Backlog 7–10 are unblocked** and
  inherit the ceiling: they may wake, and they may not bill anybody for it.

## F. Project logistics

- [x] **F1.** Solo, or a team?
  **Answered 2026-08-27:** solo.
- [x] **F2.** Hours per week?
  **Answered 2026-08-27:** 5-15, a steady side project. M0-M2 works out at roughly 3-4
  months of calendar time. Landed in *Working shape*.
- [x] **F3.** Who writes the code?
  **Answered 2026-08-27:** AI under direction. Landed in *Who is writing this, and what
  follows from it* — makes CI invariants, the conformance suite and written specs
  load-bearing.
- [x] **F4.** Any target date?
  **Answered 2026-08-27:** none. Advantage: the plan stays in risk-reducing order. Cost:
  drift is the failure mode, so the *done when* lines are the only checkpoints.
- [x] **F5.** Public or private repo?
  **Answered 2026-08-27:** public from the first commit. Two consequences recorded: the
  licence must be set before the first push, and the plugin contract must be marked
  unstable loudly until M4.

---

## Answered

- **A5** — privacy is a first-run choice, both modes switchable at runtime by command.
  Generalised the router into three axes rather than a flag per special case.
- **A4** — agentic. Biggest decision so far; created C7, C8 and C9, and changed the plugin
  contract, since plugins are tools now.
- **A3** — hotkey overlay plus Telegram. Made Alexia a background daemon; created A6, A7.
- **A1** — Alexia is the name and default wake word, user-renameable. Created A8.
- **C4** — answered as a consequence of A4 rather than asked directly.
- **C9** — agent mode works with no paid key. Local / Combined / Cloud, persistent.
- **C8** — permission model verified against Claude Code docs and adapted; created C11.
- **A7 (half)** — Local mode and Telegram coexist with exact wording. Auth still open.
- **New requirement** — Claude Code as a provider and as the checker; created C10.
- **D1, D2, F3** — stack confirmed, Windows first, AI-written code. The last one reshaped
  how much weight the automated checks have to carry.
- **D5, A6, E3** — declared permissions, channels deferred to n=3, licence split.
- **D3, D4, C7** — confirmed without a separate round: stdio, SQLite namespaces, loop in core.
- **A2, B1, B2** — setup is the pitch, tested on a real named person, five-minute ceiling.
  Together these moved a rough installer to M2.
- **B3** — answered as a consequence of C9.
- **C1, C2, C3** — providers in core (reaffirmed), the launch provider set, and memory
  split between core and a plugin. Raised C12 on trimming the step trace.
- **C5** — corrected my own misreading; introduced skills as a first-class concept and
  raised E5, E6, E7.
- **C11** — long leash, knowingly.
- **D6, E4, E6** — declarative plugin UI, Telegram then computer control, two marketplaces.
- **F1, F2, F4, F5** — solo, 5-15 h/week, no deadline, public from day one. Put real
  calendar numbers on M0-M2 and made the licence decision urgent.
- **E1, E2, D7** — backend registry, early third-party acceptance, independent updates.
  Raised risk 1 and grew risk 5; the protocol handshake is what holds it together.
- **A8, C12, E5** — display-name renaming, step-trace trimming, plugins bundling skills.
- **Learned skills** — the biggest idea of the session, from the C12 discussion. Confirmed
  Hermes already does this against the agentskills.io standard. Raised E8, E9, C13.
- **Model switching** — answered the context question; surfaced the Local-to-Cloud privacy
  trap, which reshaped how proactive detection has to work.
- **G12, G9** — a plugin may work on its own clock and spends nothing but free while it does;
  memory-that-notices is one plugin rather than two, because a second could not read the
  first's tables. Reopened G8 with the real user D90 was waiting for.
- **G11** — egress redaction is core's rule, with no way for a plugin to ask past it. The
  reason that settled it is that a plugin never sees the outbound payload in the first place.
- **E8, C13, E7, C6** — agentskills.io adopted, learned-skill offer is a model judgement,
  personality is a pass-through node that is itself a plugin, plugins can register commands.
  Raised E10 and E11.

## Dropped

*(Nothing dropped — every question either got answered or spawned a sharper one.)*

---

## To do, not decide

These are actions rather than open questions. Each is now attached to a task in
[`plan.md`](./plan.md) rather than floating.

- [x] **Set the licence files before the first public push** — Apache-2.0 on the SDK and
  protocol, AGPL-3.0 on the app. → **P0-1**, done 2026-08-27. AGPL-3.0 at the root,
  Apache-2.0 in `packages/{protocol,sdk,conformance,create-plugin}`, copyright
  *Alexia contributors*. The repo is public with the licence detected by GitHub.
- [x] **Read the agentskills.io spec properly.** → read 2026-08-27. It carries what Alexia
  needs: `name` (≤64 chars, lowercase/hyphens, **must match the folder name**) and
  `description` (≤1024 chars, must say what **and when**) are the only required fields;
  `license`, `compatibility`, `metadata` and the experimental `allowed-tools` are optional;
  unknown keys are ignored by spec-compliant runtimes, so portability holds. Progressive
  disclosure is three levels — metadata always, body on activation, `references/` on demand.
  `skills-ref validate` exists. Profile it properly at **P0-5**.
- [~] **Check Anthropic's usage terms** for driving a personal Claude subscription from a
  distributed product. → researched 2026-08-27, see D53. The consumer terms bar automated
  access except via an API key or where otherwise permitted, and bar commercial use of a
  consumer subscription; `claude setup-token` is Anthropic's own non-interactive mechanism.
  Genuinely unsettled for a distributed product, so the plugin ships disabled and the user runs
  `setup-token` themselves. **Written confirmation still outstanding** → **M4-7**.
- [ ] **Check each provider's terms** before free-tier pooling ships as a product feature.
  → **M1-6**, and now more urgent, since D51 makes pooling load-bearing rather than optional.
- [x] **Write the manifest schema and the wire protocol as documents** before building against
  them. They are the brief. → both done 2026-08-27: `docs/spec/wire-protocol.md` (P0-3) and
  `docs/spec/manifest.md` + `plugin.schema.json` generated from the zod schema in
  `packages/protocol` (P0-4).
