# Handoff · 2026-11-22 afternoon · CEO #16

## Where we are
P0, P1 done. P2: every build task merged (last: P2-39, gate 77 suites). Left: P2-41, the owner
gate: the owner runs 20 real Telegram tasks on the new core (>= 5 plugins), then a sonnet worker
writes v3/ops/reports/P2-tasks.md from `alexia-hub activity --last 200` and `runs --last 20`.
10 follow-ups are `deferred` until after the P2 gate (CEO.md §8 "Scope control").

## How the owner runs the new core
`C:\Users\vacla\Desktop\Alexia.cmd` kills the old hub (Nov 19 build, renamed to
target\release\alexia-hub-old.exe, it ran the v2 bridge with base2's core) and runs
`C:\dev\Alexia\v3\target\release\alexia-hub.exe run` in a console. Release build 2026-11-22 14:52
from cr3studioo/v3 at P2-40 (P2-39 is tests only). All v2 secrets were already in v3
(`secret import-v2`: 0 copied, 9 kept). Nothing starts it at boot yet (`alexia-hub install` would).
Do not rebuild target\release while it runs: the exe is locked.

## What I'd do next
1. `orca orchestration run-use --id run_7a40b198ac83` (a new session is fenced until you do).
   The P2-39 reviewer ctx_ca9076a694aa was never released (Orca was down); release or stop it.
2. When the owner says the 20 tasks are done: dispatch P2-41 (sonnet). Its failures list becomes
   the P3 plan's first input together with the deferred tasks and the LATER lines.
3. Then the phase-end review (CEO.md §8) and the P2 gate message to the owner.

## Candidate fixes already known (for the P2-41 list)
- resume_all publishes "Picking up where I stopped" before the gateway subscribes: the message
  can be lost after a restart (P2-39 review).
- Checker provider goes stale after the local model's idle stop (main.rs:338).

## Watch out for
- RAM: more than ~4 compiling agents kill builds. Gate uses --no-fail-fast; build bins first
  (`cargo build --workspace --bins`) or v2_plugins tests fail.
- Load-flaky: wasm.rs:541. telegram_e2e now has a 1500 ms soft bound (CEO-approved).
- Check worker terminals, not only heartbeats (P2-74 hung 2.5 h).

## Open owner asks
- Run 20 tasks on the new core (P2-41).
- Start the real claude / codex CLIs once before enabling a subscription (P2-79).
- Desktop window / plugin as_command no longer run slash commands (P2-73, per spec).

## LATER (after P2 gate), also in LOG.md
router.rs:709 · upcalls.rs:1013 · undo.rs:134 · helpers.rs:45 · INTERFACES.md:1261 ·
encrypt under in-memory secrets (hub main.rs:1012) · local.rs:1139/1283 · mcp fixture undo
summary · plus the 10 deferred tasks.
