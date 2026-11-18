# Alexia v3

> **What this doc is.** The plan for version 3: a Rust rewrite of core, a hub-and-limbs layout
> across the owner's devices, and the features the owner picked on 2026-11-18. v2 stays as it
> is until v3 can import its data and run its plugins. Decisions here are D209–D217 and are
> logged in [`Alexia.md`](./Alexia.md).
>
> Feature picker (all 294 candidates, with IDs): <https://claude.ai/artifact/4tbvG8YHamH9uWQBZXfESu>
>
> Started 2026-11-18.

---

## Why v3

Two complaints from using v2 every day:

1. **She is not proactive.** Alexia only acts when written to. Nothing in v2 decides, unasked,
   that something is worth saying.
2. **Telegram is slow.** Every message, even "hi", passes through: a Node long-poll on a Mac
   that must be awake, then stdio to core, then the full agent loop with profile, recall and
   context, then a router that tries free tiers in turn and waits out each queue or 429, then
   a draft flushed at most once a second.

Rust fixes the overhead and memory cost of the first three hops. It does not make a free-tier
model answer sooner. The speed work below is about not waiting on the wrong things.

---

## Decisions

| #    | Decision | Why |
| ---- | -------- | --- |
| D209 | **v3 core is Rust**, built as a cargo workspace that grows out of the existing `connect/` crate (D208). **Plugins stay MCP processes**, so every v2 plugin runs unchanged. The delete-the-folder invariant and the five structural rules carry over word for word. | The plugin rack is what v2 got right. A rewrite that breaks it would throw away the marketplace and the thesis. |
| D210 | **Build order: hub and Telegram first, then port core.** The Rust hub first hosts Telegram and talks to the v2 core. Core moves over piece by piece. | The owner feels the Telegram fix in weeks instead of at the end of a rewrite. |
| D211 | **The Windows PC (4060 Ti, 8 GB video memory) is the hub.** It runs all the time and owns sessions, memory, the scheduler and the Telegram gateway. **The Mac takes over when the PC is off**, answers with what it has, and syncs back when the PC returns. | A floating brain would need state replicated across machines. That costs months and is where sync bugs come from. |
| D212 | **Free cloud first, never pay.** The under-a-second goal (SP-02) is dropped as a promise. The speed work that costs nothing stays: the gateway on the hub, an instant reaction, a chat fast path, and **hedged requests** (two free providers at once, keep the first to answer, cancel the other). | Owner's choice. Hedging turns "the slowest free tier we happened to try" into "the fastest free tier right now". |
| D213 | **The GPU is for speech, vision, embeddings and images, not chat.** Resident: speech recognition, local voice, embeddings. On demand, unloaded after 10 minutes idle (SP-06): vision, OCR, image generation. **Steps aside when a game starts (MO-09).** | 8 GB can't hold a chat model and the speech stack and leave room for games. Free cloud handles chat anyway. |
| D214 | **Proactive with no daily cap, acting silently on low-risk things** (PR-05, PR-26). "Low-risk" means local, reversible and not outward-facing. **Anything that leaves the owner's devices still asks:** sending email (DY-06, defaulting to always ask) and every purchase (AC-06). Do-not-disturb (PR-07) and urgency levels (PR-06) apply even without a cap. | Without a definition, "act silently" turns into sending things. |
| D215 | **Native iOS app, installed with SideStore.** Widget, share sheet, Live Activity for running tasks, Shortcuts bridge, Watch replies. **What a free signing account can't do:** remote push (alerts come through Telegram, or local notifications when the app refreshes), and the app must be refreshed every 7 days, which SideStore does. **Call screening (PH-09) is out:** iOS doesn't let a third-party app answer calls. | Owner's choice. The limits are Apple's, so they are written down here rather than found later. |
| D216 | **Wake word detected on the hub (VO-01)** for the PC and the Mac, which stream mic audio to the hub over the mesh. **On the iPhone it's "Hey Siri, Alexia"** through a Shortcut, because iOS doesn't allow an always-listening background mic for an app like this. | Owner picked hub detection. The phone exception is a platform rule. |
| D217 | **No desktop character.** Presence is a tray and status orb that shows moods and reacts to music (CO-06, CO-08). **Alexia never replies to other people as the owner** (AC-01 no). | Owner marked the full character and message replies as no. |

---

## Shape

```
                 ┌──────────── Windows PC: the hub (always on) ────────────┐
 Telegram ──────▶│ alexia-hub (Rust)                                        │
 WhatsApp/Discord│  ├─ gateway      channels, instant ack, merge, drafts     │
 Signal/email    │  ├─ core         agent loop, router, permissions, rails   │
                 │  ├─ scheduler    proactivity engine, triggers, watches    │
                 │  ├─ store        one SQLite file + vectors (sessions,     │
                 │  │               memory, life graph, audit log)           │
                 │  ├─ mcp host     v2 plugins as processes, WASM in-proc    │
                 │  └─ gpu jobs     speech, voice, vision, embeddings, images│
                 └───────────────▲────────────────────▲─────────────────────┘
                                 │  iroh mesh (E2E)    │
            ┌────────────────────┴───┐      ┌──────────┴──────────────┐
            │ Mac limb (Rust)        │      │ iPhone app (Swift)       │
            │ screen, apps, files,   │      │ widget, share sheet,     │
            │ clipboard, mic, iMsg,  │      │ Live Activity, Shortcuts,│
            │ fallback brain (D211)  │      │ Watch, location          │
            └────────────────────────┘      └──────────────────────────┘
                    + browser extension limb on any computer (HB-17)
```

**Crates** (proposed, under `v3/`): `alexia-hub` (the binary), `alexia-core`, `alexia-gateway`,
`alexia-scheduler`, `alexia-store`, `alexia-mcp`, `alexia-limb` (the binary on each device).
`connect/` is reused as the transport. The iOS app lives in `apps/ios`.

---

## Phases

Each phase ships something the owner uses on its own. IDs are from the picker.

### V3-0: The skeleton
Cargo workspace, Rust MCP host that runs the v2 plugins unchanged, the store, the v2 importer.
CI runs core with `plugins/` empty, as before.
**Picks:** SP-11, SP-12, SP-15, SP-18, EX-01.
**Done when:** the hub boots on Windows, lists the v2 plugins' tools, and has imported v2's chats
and memory.

### V3-1: Telegram fast
The gateway on the hub, in front of the v2 core at first.
**Picks:** CH-01 (long polling, nothing exposed, because CH-02 had no option chosen), CH-03 to
CH-09, SP-03, SP-04, SP-05, SP-07, SP-14, SP-16, MO-03, MO-04, HB-12, plus hedged free requests
(D212) and the latency dashboard (SP-09, see *Parked*).
**Done when:** the reaction lands in under 300 ms, plain chat never enters the agent loop, and the
dashboard shows where every second goes on 50 real messages.

### V3-2: Core in Rust
The agent loop, router, permissions and rails ported. v2 core is retired.
**Picks:** SP-01, SP-10, SP-13, SP-17, TR-01 to TR-04, TR-08, TR-09, TR-12, AC-07 to AC-12,
MO-01, MO-02, MO-05 to MO-14, EX-12.

### V3-3: Proactive
The scheduler, plus the memory it needs to have something to say.
**Picks:** PR-01 to PR-14, PR-16 to PR-26, ME-01 to ME-18, DY-01 to DY-18.
**Done when:** a week goes by in which the owner gets the morning brief, at least one promise
followed through, and at least one deadline flagged before it was urgent, all unprompted.

### V3-4: Limbs and the mesh
**Picks:** HB-02 to HB-11, HB-17, HB-18, PC-01 to PC-20, TR-05, TR-07, TR-10, TR-11.

### V3-5: iPhone
**Picks:** PH-02 to PH-07, PH-10 to PH-12, CH-17, CH-18 (D215).

### V3-6: Voice
**Picks:** VO-01 to VO-16 (D216).

### V3-7: Everything else
Research, dev, media, life and the remaining channels, mostly as plugins.
**Picks:** RS-01 to RS-14, DV-01 to DV-12, MD-07 to MD-09, LF-04 to LF-08, LF-12 to LF-14, LF-16,
AC-04 to AC-06, CH-10 to CH-14, CO-04 to CO-08, CO-14, EX-02 to EX-11, PE-01 to PE-04, PE-06,
PE-08.

---

## Parked (not picked, not refused)

Some of these hold up picked features. Those are marked **pull in**, and the owner confirms.

- **Pull in:** SP-09 latency dashboard (it's how V3-1 proves it worked), TR-06 sandbox per plugin
  (SP-10's WASM plugins depend on it), TR-14 zero telemetry (v2 already sends nothing), CO-02
  status at a glance (v2 has it), HB-14 remote shell (PC-15 shell and scripts is the same thing on
  another device).
- **Later:** HB-13, HB-15, HB-16, CH-15 (answered by D215), CH-16, PH-01, MD-01 to MD-06,
  MD-10 to MD-14, LF-01 to LF-03, LF-09 to LF-11, LF-15, AC-02, AC-03, TR-13.

## Refused

SP-08, PR-15, PH-08, CO-01 (full character), CO-03, CO-09 to CO-13, AC-01, PE-05, PE-07.

---

## Still open

- **"Act silently" needs a list.** D214 defines low-risk. The first real list of what falls inside
  it gets written at V3-3, with the owner.
- **Hedging and provider terms.** Racing two free providers doubles requests. Check each
  provider's terms before V3-1 ships (the same check M1-6 did for pooling).
- **Mac fallback scope.** Which features run on the Mac when the hub is off, and how conflicts
  merge back. Decided at V3-4.
