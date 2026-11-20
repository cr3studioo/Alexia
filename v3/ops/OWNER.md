# OWNER

## A-01 · 2026-11-18 · answered
**What I need:** Ops Telegram bot env vars V3_OPS_TG_TOKEN and V3_OPS_TG_CHAT.
**Why:** So headless CEOs can ask and read answers.
**How:** New @BotFather bot; setx both as user environment variables.
**Until then:** OWNER.md only.
**Answer:** Set. New dedicated ops bot @MyAlexia_bot (separate from Alexia's own bot). Test message delivered 2026-11-18.

## A-02 · 2026-11-18 · answered
**What I need:** Pull in the five parked features SP-09, TR-06, TR-14, CO-02, HB-14?
**Why:** v3-plan.md marks them "pull in", owner confirms.
**How:** Yes or no.
**Until then:** n/a
**Answer:** Yes, all five.

## A-03 · 2026-11-18 · answered
**What I need:** How long gate G-P0 waits for review.
**Why:** CEO.md §9.
**How:** A duration.
**Until then:** n/a
**Answer:** No wait. G-P0 is a notice only; carry on immediately.

## A-04 · 2026-11-18 · answered
**What I need:** Acknowledge that the relay runs Claude Code with all permission prompts off.
**Why:** Safety: run it in an account that holds only this work.
**How:** Yes or no.
**Until then:** n/a
**Answer:** Yes, go ahead.

## A-05 · 2026-11-18 · answered
**What I need:** Which document wins when the old docs and the v3 plan disagree.
**Why:** Owner said to ignore what they said about the project before and follow their plan.
**How:** Standing rule.
**Until then:** n/a
**Answer:** v3-plan.md is the authority for scope, crates and tasks. Alexia.md and plan.md count only as facts about how existing v2 code works (wire protocol, data layout), never as what v3 should be. Where they disagree, follow v3-plan.md without raising it as a risk. Tell every Planner, Architect and Reviewer this.

## A-06 · 2026-11-18 · answered
**What I need:** What to do when a usage limit is hit.
**Why:** Owner has banked resets they can use.
**How:** Standing rule.
**Until then:** n/a
**Answer:** When any CEO or worker hits a usage/rate limit, send ONE Telegram message (if the vars are set): "Usage limit hit. Use your banked reset now if you want the build to keep going." Then follow CEO.md §10 as usual (handoff, ALEXIA-CEO: LIMIT).

## A-07 · 2026-11-18 · answered
**What I need:** How workers are run.
**Why:** Owner wants to see the build in the Orca app.
**How:** Standing rule.
**Until then:** n/a
**Answer:** Every worker (Planner, Architect, Builder, Reviewer, Fixer) is a supervised Orca worker started with `orca orchestration worker-start`, never the Agent tool. CEO.md §2, §7, §8 and the new §15 were changed for this with the owner's approval. The relay runs in an Orca terminal and shows each CEO live.

## A-08 · 2026-11-18 · answered
**What I need:** How the CEO runs.
**Why:** The owner wants a normal chat with the CEO, not a headless log.
**How:** Standing rule.
**Until then:** n/a
**Answer:** Each CEO is a Claude chat in Orca, in the main checkout C:\dev\Alexia. The owner can type to it. At handoff the CEO launches its successor as a new chat (`orca agent launch`, CEO.md §12). The relay (relay.ps1) is retired. On a usage limit the chat pauses; the owner uses a reset and types `continue`.

## A-09 · 2026-11-18 · answered
**What I need:** Three things for Phase 1 (fast Telegram), ready before its last tasks, a few rounds from now:
1. A **second Telegram bot** from @BotFather just for testing the hub (recommended), or say "use the real Alexia bot". (Not the ops bot @MyAlexia_bot.)
2. **Free AI provider keys**: which of Groq, Cerebras, Google AI Studio, OpenRouter, Mistral, NVIDIA, GitHub Models you have keys for. **At least two** are needed for racing two providers. Only say which ones; don't paste any keys here.
3. That you've read the free-tier terms of those providers and are OK with each chat message going to two providers at once (v3-plan "Still open").
**Why:** Phase 1 is planned (v3/specs/P1/PHASE.md, "Owner needs"). The hub talks to Telegram and to free models directly.
**How:** Answer under **Answer:** or on Telegram ("A-09 ..."). You'll enter tokens and keys later, on the PC, with `alexia-hub secret set <name>`, which reads them hidden from the keyboard. That command doesn't exist yet; I'll tell you when it does. Later, once only: switch off v2's Telegram plugin before the hub uses the real bot, and run `alexia-hub install` from an Administrator terminal for the watchdog.
**Until then:** Phase 0 and the Phase 1 code keep going. Only the final real-message run (P1-18) waits.
**Answer:** (chat, 2026-11-19) 1. Use the real Alexia bot (the bot given to CEO #1 is the separate ops bot). 2. Keys come from v2 (six providers found, see A-11). 3. Racing two providers is OK.

## A-10 · 2026-11-19 · notice (G-P0, no wait per A-03)
**What I need:** Nothing. Phase 0 (the v3 skeleton) is merged on `cr3studioo/v3`. Try it if you want.
**Why:** Phase gate G-P0.
**How:** What works now: a Rust hub that runs the v2 plugins unchanged through its own MCP host, its own store (secrets in Credential Manager), an importer for v2 data, and CI (`.github/workflows/v3.yml`). Every v2 plugin in `plugins/` starts and lists its tools (15 of 15, locally and on GitHub). To try it, in PowerShell at the repo root, after `pnpm install`:
```
cd v3; cargo build --release
$env:ALEXIA_PLUGINS_DIR = "C:\dev\Alexia\plugins"
.\target\release\alexia-hub.exe plugins
.\target\release\alexia-hub.exe tools
```
`plugins` shows each plugin's status, and `tools` lists every tool. This is the by-hand check P0-14 left for you. `alexia-hub run` starts everything (Ctrl+C stops it). The contracts are in `v3/specs/INTERFACES.md`.
**Until then:** Nothing waits. Phase 1 (fast Telegram) is being built.
**Answer:**

## A-11 · 2026-11-19 · answered
**What I need:** A yes or no: may v3 copy your v2 keys out of Windows Credential Manager into its own store (a copy; v2 keeps its own)?
**Why:** Owner asked in chat whether v3 can see the v2 keys. It found them (names only, values never printed) in the v2 entry `_core.vault.dev.alexia.app`: provider keys for OpenRouter, Groq, Cerebras, Google, Mistral, NVIDIA, plus the Telegram bot token and two plugin keys (hello, voice). v3 keeps secrets in its own entries (service `alexia`), so today it cannot use them; nothing copies them yet.
**How:** Answer yes/no. With yes, a small task adds `alexia-hub secret import-v2`, which you run once; no key passes through any chat, file or log. With no, you enter each key with `alexia-hub secret set <name>`.
**Until then:** Nothing stops. This also answers part 2 of A-09 (six free providers available). A-09 parts 1 (test bot or use the real bot) and 3 (OK to race two providers) are still open.
**Answer:** (chat, 2026-11-19) Yes: build alexia-hub secret import-v2 and take the keys from v2.

## A-12 · 2026-11-19 · answered
**What I need:** Run the v2 key import once, on this PC.
**Why:** You approved it (A-11). Phase 1's real-message run needs the keys in v3's own store.
**How:** In PowerShell: `C:\dev\Alexia\v3\target\release\alexia-hub.exe secret import-v2`. It prints only key names (copied / already there / not found), never a value, and leaves v2 untouched. Paste the printed names back here or in the chat if you like.
**Until then:** The automated speed test (P1-18) keeps going; only the real 50-message run (P1-33) waits.
**Answer:** (chat, 2026-11-20) "Do everything yourself, do the import also." Standing rule from now on: the CEO runs by-hand steps on this PC itself and asks the owner only for what physically needs them (e.g. sending a message from their own Telegram account).

## A-13 · 2026-11-20 · notice (decided by CEO per A-12 standing rule; owner may override)
**What I need:** Nothing now. Phase 2's "Owner needs" (v3/specs/P2/PHASE.md) decided with defaults:
- TR-06 pulled in (bootstrap default: yes to the parked features).
- MO-05 subscriptions: built but OFF. Turning one on (e.g. your Claude Code plan) is your call later, because of D212.
- Checker: a small local model as an on-demand GPU job, unloaded when idle and for games (not chat, D213).
- SP-17 speculative decoding: only for local non-chat jobs.
- TR-09 database encryption: the command gets built; the CEO will not encrypt your database until you say how to back up the key.
- Scope folders, game folders, llama.cpp download (~650 MB): the CEO sets these up on the PC when the tasks land.
- P2-41's 20 real tasks: you just use Alexia; the CEO reads the results.
**Why:** You asked the CEO to do everything itself.
**How:** Write under Answer only if you disagree with one.
**Until then:** Nothing waits.
**Answer:**


## A-14 · 2026-11-20 · answered
**What I need:** (owner, in chat) Skip the 50-message test; 3 messages worked. Main wish: get the full plan built, it is taking long (about 7 usage resets so far).
**Answer:** Done. P1-33 closed with the 3 real messages (ack max 86 ms). CEO keeps building P2 onward.
