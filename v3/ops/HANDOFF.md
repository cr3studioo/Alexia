# Handoff · 2026-11-20 evening · CEO #13 → CEO #14

## Where we are
P0, P1 done. P2: 50 tasks; merged 33 / running 2 (P2-17, P2-08) / review 0 / ready 0 / todo 15 / failed 0 / blocked-owner 0. Overall ~33%.

## What I'd do next
1. `orca orchestration run-use --id run_7a40b198ac83`, then `bash C:/dev/Alexia-wt/wait.sh` in the background. P2-17 and P2-08 are live; leave them.
2. While they build: hire a Reviewer for the whole-phase review (23 merges since review 4, §8), and a Planner to turn the follow-ups below into P2-51.. task specs. Run them in the main checkout one at a time (disk/RAM).
3. When P2-17 merges: P2-20 (opus, the agent loop) is the critical path; then P2-35, P2-36. When P2-08 merges: P2-29.
4. Delete each approved worktree's v3/target right away; keep builders <= 4.

## Watch out for
- Disk and RAM are the bottleneck, not usage. See STATE.md "MACHINE LIMITS".
- Branches cut before another merge can break at integration (P2-07 vs P2-30: new Turn field). Gate catches it; undo the unpushed merge with `git reset --hard <merge>^1` (stash the books first; `git stash` moves ORIG_HEAD, so don't use ORIG_HEAD after a stash). Then a small fixer merges v3 into the branch.
- Combining several approved, disjoint branches into one gate saves a 30-60 min gate each; it worked 4 times.
- Orca showed dead workers as live for 15 h; check claude.exe processes when a worker is silent for hours.
- The owner relays "You have N orchestration messages" constantly; one-line answers.

## Follow-ups from reviews (file as tasks)
- permissions.rs:332 'FILE://' uppercase / 'file:/' skip never-touch (P2-46)
- INTERFACES.md: add '// invariant: bot api term' exception (P2-11); IBAN/card/OTP row at :1053 doesn't match v2 (P2-14)
- encrypt.rs crash recovery: key stored but db plain; leftover alexia.db.plain never removed; Store::open hits real keychain in tests (P2-37)
- openai.rs: unanswered assistant tool_call still sent; non-array delta.tool_calls ignored; nameless streamed call dropped (P2-04)
- alexia-mcp conn plugin_cancel_reaches_incoming flake (possible race)
- rust-version 1.85 -> 1.87 (std::io::pipe, P2-24); wasm spawn blocks a tokio worker during compile
- scheduler: cut-short one-shot lost at shutdown; Every can overlap itself; desktop origin session (P2-30)
- hf.rs: hash_file blocks tokio; damaged cache dir never repaired; \?\ paths to llama-server (P2-33)
- gpu.rs: XML entities, OEM codepage in reg output, flapping game_over, comma split (P2-32)
- gateway: file message ordering after steers; tests wait fixed 1 s (P2-07)
- redact: secret-named JSON keys with unrecognisable values pass (P2-14)
- prompt.rs:210 symlink check fails open on canonicalize error (P2-16)
- trace: resumed run's 'at' is resume time (P2-19); resume check-then-update window

## Open owner asks
- none (A-16 answered yes; A-17 progress lines standing rule)

## Decisions I made (also in LOG.md)
- Portable Strawberry Perl in C:\dev\Alexia-wt\tools for SQLCipher; all prompts and gate set OPENSSL_SRC_PERL.
- P2-24 may change alexia-mcp/Cargo.toml (wasmtime-wasi preview1) and Cargo.lock.
- Accepted P2-31's real-time idle test (no tokio test-util); accepted per-crate checks for builders under low memory.
- Max 4 builders (RAM); delete approved worktrees' target/ (disk).
- P2-07 integration fix merged without a second full review (one line, gate verified).
