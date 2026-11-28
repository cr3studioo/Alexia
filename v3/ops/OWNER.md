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

## A-15 · 2026-11-20 · answered
**What I need:** (CEO offer in chat) Build P2 with Sonnet to save usage, keep Opus for reviews and the core pieces.
**Answer:** "yes cheaper". P2 builders are Sonnet except P2-12 permissions, P2-13 checker, P2-20 agent loop, P2-37 encryption (and P2-01/03, already running on Opus). Reviews stay Opus. Board Model column is the authority over a spec's Model line.

## A-16 · 2026-11-20 · answered
**What I need:** A yes or no: may I install Strawberry Perl on this PC (`winget install StrawberryPerl.StrawberryPerl`)?
**Why:** The database encryption task (P2-37) uses a library that needs a full Windows Perl to build; this PC has only Git's cut-down Perl. Once that library is in, every v3 build needs Perl.
**How:** Answer yes/no here, in chat, or on Telegram ("A-16 yes"). With yes, the CEO runs the winget command itself. With no, the CEO keeps a portable Perl inside C:\dev\Alexia-wt\tools (no system install) and points builds at it.
**Until then:** The builder uses the portable Perl in C:\dev\Alexia-wt\tools; nothing waits. Encryption stays off by default either way (A-13).
**Answer:** (Telegram, 2026-11-20) "A-16 yes". CEO ran winget install: it ended with 1602 (cancelled), most likely the Windows admin prompt went unanswered. Builder uses the portable Perl meanwhile.

## A-17 · 2026-11-20 · answered (standing rule)
**What I need:** (owner, in chat) A Telegram message every time something finishes, with progress, e.g. "Phase 2 finished, 25% done".
**Answer:** Standing rule. The CEO sends one short Telegram line after every merge and phase end: what merged, phase count, overall %. Overall % = (phases done + fraction of the current phase merged) / 8. This overrides the "one message per round" limit in CEO.md §9 for progress lines only.

## A-18 · 2026-11-22 · answered (standing rule)
**What I need:** (owner, in chat with CEO #17) Use both Claude subscriptions: c1 = vaclavnejedly6@icloud.com (`C:\Users\vacla\.claude`), c2 = cr3.studioo@gmail.com (`C:\Users\vacla\.claude-backup`).
**Answer:** Standing rule, details in CEO.md §16. Every CEO and every worker starts on the account `C:\Users\vacla\.claude-usage\usage.ps1` names. Leave an account at 95% of the 5-hour limit or 98% of the week. CEO and workers both switch. When both are full, the CEO sends one Telegram line and schedules its successor to start 5 minutes after the earliest reset (the PC is on 24/7); the A-06 "banked reset" message is sent only then. CEOs and workers are started with `c1`/`c2` in an Orca terminal, not `orca agent launch --agent claude`, which uses the account picked in the Orca app. CEO #17 installed the usage status line in both config folders.

## A-19 · 2026-11-23 · answered (standing rule)
**What I need:** (owner, in chat with CEO #16 and #17) What comes after the P2 code.
**Answer:** (1) P2-41 is waived: the owner won't run 20 Telegram tasks ("I don't have time to send 20 tasks to it, when it cannot even do stuff on my computer"). (2) Phase 2D, before Phase 3: "I want the app back ... a full fledged app, just built on Rust, look the same but feel snappier, and have the features." Keep packages/ui as it is, make alexia-hub answer every API call the v2 core's serve.ts answers (same requests, same responses), point the Tauri shell at alexia-hub instead of the Node core, and bring back every v2 feature the app shows, including Alexia doing things on the owner's PC the way v2 could. Telegram and the window share one brain. No follow-up sprawl (CEO.md §8 scope control).

## A-20 (2026-11-24): Phase 2D accepted, go to Phase 3
Owner: "okay good continue to the next phase" after the new Rust app was installed on this PC
(v2 program removed, data kept). Phase 2D gate passed; Telegram "p2d ping" still to be sent by the owner.

## A-21 · 2026-11-24 15:00 · answered
**What I need:** Your answers to Phase 3's nine questions, in `v3/specs/P3/PHASE.md` under *Owner needs*. Short answers are fine, e.g. "1 ok, 2 05:00/09:00 no shortcut, 3 ok, 4 Google yes (account x), no Microsoft, 5 none, 6 Obsidian, 7 ChatGPT export, 8 later, 9 defaults".
**Why:** They decide what Alexia may do without asking (1), when the morning brief comes (2), quiet hours and wrap-up times (3), which accounts she reads (4, 5, 6), imports (7), screen memory (8) and health nudges (9).
**How:** Write under Answer, type it in the CEO chat, or reply on Telegram starting with "A-21". For 4 (Google): P3-20's README will walk you through making a free "Desktop app" OAuth client once that task lands; nothing to do yet but say which account.
**Until then:** Everything is built with the safe defaults: the silent list is empty (proactive runs only read and ask), brief after first activity past 05:00 or at 09:00, quiet 23:00–07:00. Only connecting real accounts (Google, Microsoft, school portal) waits.
**Answer:** (owner, picker in the CEO chat, 2026-11-24)
1. Silent list: approved as proposed in PHASE.md Owner needs 1.
2. Brief: first sign of the owner after 05:00, else 09:00, plus the optional iOS Shortcut "unlock" signal (CEO sets up the PC side in P3-33 and gives the owner the phone steps).
3. Quiet hours 00:00-08:00 (only Urgent gets through); evening wrap-up 22:00; weekly review Sunday 18:00.
4. Accounts: Google only (no Microsoft for now; P3-21 builds but stays unconnected).
5. School portal: https://moodle.fel.cvut.cz/ (Moodle, CVUT FEL). Read only; login goes in Credential Manager.
6. Notes app: Apple Notes. Needs the Mac limb (V3-4); P3-18 builds folder/Markdown sync now, Apple Notes waits for V3-4.
7. Imports: ChatGPT, Claude and Gemini exports; the owner gives the files when P3-15 lands.
8. Screen memory: CEO turns it on once P3-19 is merged and reviewed.
9. Health nudges: sleep, activity and resting heart rate.

## A-22 · 2026-11-24 · answered (standing rule)
**What I need:** (owner, in chat with CEO #18) C: is almost always full and slows everything; move work to the external D: (Samsung T7 USB SSD, ~900 GB free).
**Answer:** Standing rule. New task worktrees go in `D:\Alexia-wt\<id>` (their Rust build output lands there too), workers run with TEMP/TMP = `D:\alexia-tmp` (tests leak `alexia-*` temp dirs), and the gate builds into `D:\alexia-target\main`. This overrides CEO.md §1.7's "<repo>-wt\" for these folders only. Existing C: worktrees finish where they are. `C:\dev\Alexia\v3\target\debug` (most of its 110 GB) is deleted once the P3 planner stops building there; `v3\target\release` stays (the hub runs from it). Owner data (`%LOCALAPPDATA%\Alexia`, 58 GB) is not moved without asking. Risk: if D: is unplugged, running builds fail; branches are committed, so little is lost.

## A-23 · 2026-11-25 16:10 · answered (standing rule)
**What I need:** OK to (A) exclude the build folders from Windows Defender and (B) install sccache, to speed builds up and stop slowing the PC.
**Why:** Defender scanned every file the Rust builds wrote, and each task compiled every dependency from scratch.
**How:** (A) Add-MpPreference -ExclusionPath C:\dev\Alexia-wt, C:\dev\Alexia\v3\target, D:\alexia-target, plus -ExclusionProcess cargo.exe, rustc.exe, sccache.exe (done by the CEO through a UAC prompt). (B) cargo install sccache --locked.
**Until then:** n/a
**Answer:** (owner, in the CEO chat) "i give you permission to do both". Also: the owner asked why C: was at 100% and why D: is not used: Rust build output goes to D:\alexia-target\<id> again (the 3 mcp-fixture same-drive tests are known environment failures there; accept them).

## A-24 · 2026-11-25 17:00 · answered (standing rule: B)
**What I need:** Owner wants all of v3 in two days. Two speed-ups need your say: (A) more Claude usage (extra usage on c2, or a third account), so workers never pause on a limit; (B) skip the separate Opus reviewer for low-risk Sonnet tasks (adapters, UI, docs), with the CEO checking those itself; security, core and Opus tasks keep full reviews.
**Why:** c1 is full until 11-27 and c2's 5-hour window stops all work when it fills; each review is an extra agent run per task.
**How:** Type A, B, or both in the CEO chat (or reply on Telegram starting with A-24).
**Until then:** P4 is being planned now to run in parallel with the rest of P3; everything else continues as before.
**Answer:** (owner, in the CEO chat, 2026-11-25) B: no separate reviewer for low-risk Sonnet tasks (adapters, UI, docs); the CEO checks those itself (spec, allowed paths, Done when commands, secrets, invariant). Security, core and every Opus task keep the full Opus review. A (more usage) not chosen.

## A-25 · 2026-11-25 21:00 · open
**What I need:** Your yes, or your changes, to eight Phase 4 (devices) questions. Each has a default, and work goes ahead on the defaults.
1. **Mac limb:** at the end of P4, about 30 minutes at the Mac to pair it and grant Accessibility and Screen Recording. Should any computer other than the Mac get one?
2. **Away from home:** without Tailscale, the Mac reaches the PC only on the same home network. Install Tailscale (free) on the PC and the Mac? Default: no. Away from home, the Mac answers on its own.
3. **Wake-on-LAN:** turn on "Wake on LAN" / "Power on by PCI-E" in the PC's BIOS and "Wake on Magic Packet" on its network adapter. Default: the CEO turns on the adapter setting, and you do the BIOS setting when convenient.
4. **Mac answers while the PC is off:** this needs the bot token and the free model keys in the Mac's keychain. You type them on the Mac with `alexia-limb secret set <key>`. They are never sent over the network. Default: yes.
5. **New things she may do without asking:** show a notification on a device, copy to a device's clipboard, draw on screen and clear it, save a window layout. She always asks before power actions, installs, shell commands that change things, moving or deleting files, browser clicks or form fills, and anything a guest asks for. Default: yes.
6. **Guests on Telegram:** who are they, and may a guest use any tool (weather, timers)? Default: talk only, and no guests until you name them.
7. **Local-only mode:** this pauses Telegram, because Telegram goes through Telegram's servers, but keeps the link between your own devices on. Default: yes.
8. **Browser for the extension:** Chrome or Edge, and on which computers? Default: Chrome on the PC and the Mac.
Also, `v3-plan.md` gives Phase 4 no "done when". The proposal is in `v3/specs/P4/PHASE.md` under "Done when". Default: accepted.
**Why:** Phase 4 links the PC and the Mac. These answers are needed by its last tasks, so I'm asking now so nothing waits.
**How:** Reply in the CEO chat or on Telegram starting with "A-25", for example "A-25 ok" or "A-25 2 yes, 8 Edge".
**Until then:** All P4 building continues on the defaults. Only the owner steps (P4-43, P4-44) need the answers.
**Answer:**

## A-26 · 2026-11-25 21:10 · answered (standing rule)
**What I need:** (owner, in the CEO chat) Why is memory low? It never happened before.
**Why:** Claude Code stopped the CEO's background wait because the PC was critically low on memory. The causes were 5 workers, a full JS test suite (about 25 node processes, about 3 GB), two Rust builds, and CEO #20's old session still open.
**Answer:** (owner) "do whatever it takes. but i [want] phase 3 will be done". Standing rule: at most 4 workers at once; at most one full JS test run (pnpm check / pnpm test) at a time; plugin builders test only their own plugin (the CEO runs pnpm check once at merge). Finished CEO sessions are closed (CEO #20's was closed). Phase 3 comes first: every free slot goes to a ready P3 task before any P4 task.

## A-27 · 2026-11-26 15:00 · open
**What I need:** Four things so your Phase 3 week runs fully.
1. **Trust the new plugins** in Alexia's window (Plugins): apple-context, day-planner, errand-kit, file-finder, google-account, notes-library, page-watch, screen-memory, study-desk, task-list, web-research. Until then their tools always ask, and 5 silent-list entries do nothing.
2. **Google:** plugins/google-account/README.md steps 1-5, then paste Client ID and secret into Plugins > Google.
3. **Moodle:** your login in the page-watch plugin settings (the password goes to Credential Manager).
4. **Autostart:** may the CEO run `alexia-hub install` (a Windows scheduled task that restarts the hub after a reboot or crash)?
**Why:** The real hub runs now with your A-21 settings; these are the parts only you can do or approve.
**How:** 1-3 in the window. 4: reply "A-27 4 yes" in the CEO chat or on Telegram.
**Until then:** The hub runs and briefs you; unreviewed plugins ask before every tool; no Google or Moodle items; the hub does not come back by itself after a reboot.
**Answer:**

## A-28 · 2026-11-26 15:05 · answered
**What I need:** (owner, in the CEO chat, upset that Phase 3 was "done" two hours ago) What to do with the Phase 3 review findings, given c1 is full until 11-27 12:00 and c2 has ~9% of its week left.
**Answer:** (owner) "Only the 2 holes now": fix P3-39 and P3-40 tonight on c2. P3-41..43 are built 11-27 on c1 alongside Phase 4.

## A-29 · 2026-11-28 16:00 · answered
**What I need:** (owner, in the CEO chat) Pace while D: is unplugged.
**Answer:** (owner) Finish the tasks running now (P4-31, P4-12, P4-04 review), start nothing new, then wait until the owner plugs the T7 SSD (D:) back in at home. Also asked about +16 GB RAM: CEO estimate 1.3-1.5x, Opus cap and serial merge gate limit the rest.

## A-30 · 2026-11-28 21:16 · answered (standing rule: fast mode)
**What I need:** (owner, in the CEO chat) "this is taking too long ... build the 2 phases completely and then [run] the rust one time ... build fast and we can fix issues after. it has been building for 7 days already."
**Answer:** Fast mode for P4 (rest) and P5. Builders write code and tests but run no cargo/pnpm build or test. No per-task reviewer and no per-merge gate: the CEO merges each finished branch at once (deps still respected; textual conflicts resolved). Up to 5 workers (no compiles, so memory is fine). When P4 and P5 code is all in: one full Rust build/clippy/test (+ pnpm check), then Fixer workers fix what fails, crate by crate. The §1 hard rules (main, release, secrets, Alexia Dev, v2 paths) are unchanged. This also answers the hot-SSD question: no compiles means almost no writes to D:.
