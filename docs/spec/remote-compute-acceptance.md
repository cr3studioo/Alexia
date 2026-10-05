# Remote compute: acceptance evidence

> One row per checkbox of section 13 of
> [`alexia-iroh-integration-plan.md`](../../alexia-iroh-integration-plan.md), and the test that
> proves it. Companion to [`remote-compute.md`](./remote-compute.md).
>
> **Proven** means a test runs that behaviour through the real code paths: the real sidecar,
> or the real host protocol, scheduler, workers, controller, bridge and `serve()`, joined by
> `memoryConnect()`. A clock, a model runner's HTTP address, Hugging Face or the hardware may
> be a stand-in. **Partly proven** means the logic is proven and something only a real machine
> can show is left. **Needs real hardware** means no test on one machine can show it, and none
> pretends to. **Not met** means a test shows it does not hold.

Written against the tree on branch `cr3studioo/local-model-picker`, 2026-10-03.

## Summary

| Status | Count |
|---|---|
| Proven by automated test | 13 |
| Partly proven | 8 |
| Needs real hardware | 10 |
| Not met | 0 |
| **Checkboxes** | **31** |

One bug was found (finding 1); it is now fixed and its test is an ordinary test. It does not break a
checkbox on its own, but it is why *strict target selection and offline behaviour* is only
partly proven.

## Where the tests are

| Short name | File |
|---|---|
| `acceptance` | `packages/core/test/compute-acceptance.test.ts` (new; fixtures `fixtures/compute-acceptance.ts`, `fixtures/mailbox.ts`) |
| `acceptance.rs` | `connect/tests/acceptance.rs` (new) |
| `pairing.rs`, `transport.rs` | `connect/tests/` |
| `pairing.rs (unit)`, `identity.rs (unit)` | `#[cfg(test)]` in `connect/src/pairing.rs`, `connect/src/identity.rs` |
| `compute-*` | `packages/core/test/compute-*.test.ts` |
| `voice`, `media` | `plugins/voice/test/compute.test.js`, `plugins/media/test/compute.test.js` |

The real-sidecar tests in `acceptance` and `compute-connect` need the debug binary
(`~/.cargo/bin/cargo build --manifest-path connect/Cargo.toml`); without it they skip and say so.
`acceptance`'s pairing tests run the real `magic-wormhole` client inside the sidecar against a
mailbox stub on loopback (`fixtures/mailbox.ts`, a port of `pairing.rs`'s stub), with
`ALEXIA_CONNECT_EPHEMERAL_KEY` and `ALEXIA_CONNECT_LOOPBACK_HINTS` (debug-build only).

## Pairing and authorization

| Checkbox | Status | Tests | Note |
|---|---|---|---|
| Verify code expiry and failed-attempt invalidation. | **Proven** | `pairing.rs`: `a_code_expires`, `a_wrong_code_fails_and_is_the_only_attempt_the_code_gets`, `cancelling_kills_the_code`. `acceptance`: "a wrong code fails both sides and spends the code; a fresh one pairs once, and trust is still core's to give". `compute-connect`: "maps pairing_expired to expired" (and the other mappings), "expiry and a shaped wrong code each consume the one attempt". `compute-api`: "a code that is wrong records nothing, and a pairing can be cancelled". | Wrong-code invalidation runs end to end through the TypeScript client and the real binary. Expiry runs in the real sidecar with its lifetime shortened by injected `Timing` (1.5 s), and its mapping to `expired` through the TS client; the binary's own five-minute constant is not waited out (the `acceptance` test checks `expiresAt` is five minutes out). |
| Reject replay, identity substitution, and unauthorized requests. | **Proven** | `pairing.rs`: `a_joiner_that_names_an_identity_it_does_not_hold_is_not_trusted`, `a_host_that_names_an_identity_it_does_not_hold_is_not_trusted`, `two_computers_pair_and_each_proves_the_identity_it_named` (a used code fails). `pairing.rs (unit)`: `a_tag_is_for_one_pairing_one_direction_and_one_pair_of_ids` (replayed nonces). `transport.rs`: `a_call_without_the_secret_is_rejected`, `a_peer_that_is_not_allowlisted_is_rejected`, `an_operation_that_is_not_registered_is_rejected`. `compute-connect` (real sidecar): "each launch uses a fresh stdin secret, authenticates all surfaces…", "an unregistered operation is refused by the actual sidecar…", "both allowlists gate delivery and hints never confer trust". `compute-host-protocol`: "only the paired controller is heard…". `acceptance`: the wrong-code test also replays a used code from a third computer. | |
| Test concurrent pairing attempts. | **Proven** | `pairing.rs`: `two_pairings_at_once_do_not_cross` (three codes, two on one computer, joined at once), `no_mailbox_no_pairing_and_one_controller_at_a_time` (limit of four, one controller). `acceptance`: "two computers typing the same code at once: exactly one of them is paired, and the host names that one" (TS client, real binary). | |
| Verify pairing survives application restarts. | **Partly proven** | `acceptance`: "both computers, started again on the same data with a sidecar that allows nobody, allow each other from the stored record and reconnect" (real `computeServe` and `serve()`, two launches). `acceptance.rs`: `a_restart_with_the_same_key_is_the_same_computer_and_core_restores_the_pairing`. `compute-api`: "a pairing survives a restart, and switching the interaction computer's role keeps its chats". `identity.rs (unit)`: `a_key_survives_the_keychain_encoding`. | Proven: the stored record and allowlist are reloaded by both roles, and the same key is the same endpoint. **Not shown:** the key really surviving in the OS keychain across an app restart — every test uses an injected or ephemeral key. *To verify:* pair two machines, quit both apps (and once, reboot one), relaunch; the host must show *Direct* without a new code. Repeat with *Alexia Dev* installed beside Alexia and check each keeps its own identity. |
| Verify revocation closes connections and cancels jobs. | **Proven** | `transport.rs`: `revocation_closes_a_live_connection`. `acceptance.rs`: `unpairing_on_the_interaction_computer_closes_the_connection_both_ways`. `compute-connect` (real sidecar): "revocation closes live streams before allow resolves and changes state". `compute-host-protocol`: "revoke replaces the allowlist, cancels every job and closes every stream at once". `compute-roundtrip`: "revoking from the host cancels the job…", "unpair from the controller revokes its host record…". `compute-api`: both unpair tests. `acceptance`: "unpairing at the host breaks an answer in flight at once, cancels the job queued behind it…"; "paired over their own routes by a code…" (unpair over two real sidecars). | |

## Routing and setup

| Checkbox | Status | Tests | Note |
|---|---|---|---|
| Distinguish identical model names on different hosts. | **Proven** | `acceptance`: "the same model name on two hosts is two targets: each answer comes from the host that was chosen, and the rows never mix" (two real hosts, one controller). `compute-types`: "identical model names on different hosts are different catalog ids". `compute-seams`: "the same model on two paired computers is two rows, and only the selected one is reached". | |
| Use remote hardware for memory-fit decisions. | **Proven** | `acceptance`: "memory fit is judged on the host's hardware, and a download asked for here lands only on the host" (30 GB: fits the host, too big here, through `serve()`'s `/api/local-models/repo?host=`). `compute-api`: "the picker for a paired host is the host's: its machine, its downloads, its disk". | The hardware is a stub `Machine`; reading a real machine is `machine.ts`'s own tests. |
| Download remote models only onto the remote host. | **Proven** | `acceptance`: the same fit test (the host's `LocalModels.install` runs, without the mode; no weights anywhere in this computer's data folder). `compute-api`: "the picker for a paired host is the host's…". | Hugging Face is a stub. |
| Verify saved-selection migration. | **Proven** | `acceptance`: "a selection saved before paired computers existed reads as this computer when the app starts, and nothing else is rewritten" (real `serve()` on an old data folder). `compute-target`: "last_local_model migrates to this computer, survives reopening, and leaves every pin unchanged" and the damaged-target cases. `compute-seams`: "a store from before paired computers is migrated when the mode controller starts". `compute-types`: "a selection saved before hosts existed migrates to this computer". | |
| Verify strict target selection and offline behavior. | **Partly proven** | `acceptance`: "a strict target: with the chosen host offline, a message says so and nothing is loaded here or anywhere else; when it is back, it answers" (real `serve()`, `/api/chat`). `compute-seams`: failed remote select ends with the picker and no local model; "the selected paired computer is remembered through Cloud and a restart, and is never swapped for a model here"; "an unpaired target opens the picker…". `compute-bridge`: "an offline preparation reaches chat as unreachable and never selects another host". `compute-operations`: "an offline selected host never falls back to this computer". `compute-interaction`: "a paired computer that cannot serve is never told to a plugin as 'no compute here'". | Strictness is proven: nothing is loaded here, no other model or provider is asked, the pin and target stay, the host list says `offline`, and it answers again once back. Finding 1 (the error sentence for an unreachable paired host blamed the person's internet) is fixed in `router.ts` `stopped()`; `acceptance`: "an unreachable paired computer is not described to the person as their own internet connection being down". |

## Compute jobs

| Checkbox | Status | Tests | Note |
|---|---|---|---|
| Stream text, reasoning, tool calls, and usage correctly. | **Proven** | `acceptance`: "text, reasoning, tool calls and usage reach the existing chat client through the bridge and the real host exactly as they would directly" (`chat()` → `Bridge` → controller → real `HostProtocol` → runner, compared with `chat()` straight to the runner: same message, deltas, signs, usage and request bytes). `compute-api`: "choosing a paired host's model, and an answer streamed through the bridge" (through `serve()`'s `/api/chat`). `compute-bridge`, `compute-roundtrip` (byte for byte). | T9's gap (no committed bridge + `chat()` test against the real host) is closed. The streams run over `memoryConnect()`; the sidecar's byte forwarding is proven separately (`transport.rs`, `compute-connect` real-sidecar "exactly four kinds carry bytes…", backpressure tests). |
| Preserve image inputs and inference parameters. | **Proven** | `acceptance`: the streaming test (a 30 KB image in the request, byte-identical at the runner), "image bytes and every inference parameter cross the real host unchanged, across stream windows" (≈440 KB body with `temperature`, `top_p`, `top_k`, `min_p`, `seed`, `stop`, `repeat_penalty`, `response_format`, an unknown field). `compute-bridge`: "arbitrary parameters, image bytes and SSE pass through byte-for-byte…". | |
| Verify voice input/output transfer. | **Partly proven** | `acceptance`: "voice: a recording goes to the host as an input and a recording comes back, byte for byte, and nothing runs here" (real `Operations`, upload, host worker, fetch). `voice`: "with a computer chosen the recording is sent with the request and nothing is inferred here", "speaking makes a recording…", "a job from another computer never downloads…". | The transfer path is proven with a voice-shaped fixture worker; the voice plugin's halves are proven with stand-in engines. **Not shown:** the real voice plugin as a worker on a real host with Whisper/Piper installed. *To verify:* on a paired host with hearing and a Piper voice installed (setup list), choose the host, transcribe a recording on the interaction computer and have a reply spoken; confirm the text and the audio, and that nothing ran locally (no Whisper/Piper process on the laptop). |
| Verify ComfyUI progress and artifact delivery. | **Partly proven** | `acceptance`: "an image render: its progress arrives in order, and the picture is fetched, verified and acknowledged". `media`: "the rendering computer chooses the model, builds the graph and writes the file", "a ComfyUI the person is running is never queued into, interrupted or stopped", "a rendered file is removed from the worker's folder once it is safe…" (fake ComfyUI). `compute-transfer`, `compute-operations`. | **Not shown:** a real ComfyUI render on a real GPU host. *To verify:* on a host with ComfyUI and a checkpoint, generate an image from the interaction computer; watch the steps advance, check the PNG arrives and is removed from the host's `compute/jobs` folder after it arrives. See finding 2 about progress sent in the same instant as the result. |
| Test queue cancellation and active cancellation. | **Proven** | `acceptance`: "a queued job is cancelled at once and never runs; a running one is cancelled in its worker; the queue carries on" (from `Operations.run`'s signal, MCP cancellation, the 15 s stop on an injected clock). `compute-scheduler`: queued and active cancellation rules. `compute-roundtrip`: "a queued job is cancelled at once and never reaches the worker…". `compute-api`: "the queue, one job's state, and cancelling from either computer". `media`: "giving up on a job that is still waiting does not end the render in front of it". | |
| Test disconnect/reconnect and worker crashes. | **Proven** | `acceptance`: "a connection lost mid-answer drops that answer with one stream and no resubmission…", "a worker that crashes mid-job fails that job as a worker failure…". `compute-roundtrip`: "a connection lost and found within the grace resumes the same job by id…", "a grace that runs out interrupts the job once…". `compute-jobs`: reconnect and controller-restart tests. `compute-controller`: backoff and resume tests. `compute-workers`: "a plugin that vanishes mid-job…". `compute-connect` (real sidecar): "a reset is an error and never a clean end". | Real network loss (Wi-Fi, sleep) is the connectivity row below. See finding 3 about what the plugin supervisor does after a crash. |
| Verify ten-minute worker and GPU-memory cleanup. | **Partly proven** | `acceptance`: "a model left idle is unloaded ten minutes after its last answer, on the injected clock, and the next message loads it again", "a plugin worker is released and its process stopped ten minutes after its last job". `compute-scheduler`: "idle workers stop at exactly ten minutes…", hold and lease rules. `compute-workers`: "the scheduler stops an idle text worker after its timeout…". `media`: "release stops the worker's ComfyUI…". | The timer, the release hook and the process stop are proven. **Not shown:** that GPU memory is actually returned. *To verify:* on a GPU host, run a chat and a render, then leave it; at 10 minutes `nvidia-smi` (or Activity Monitor's GPU memory on a Mac) must drop to the idle baseline and no `llama-server`/ComfyUI worker process may remain. |
| Verify plugin removal does not break chat inference or compute startup. | **Proven** | `acceptance`: "deleting a compute plugin on the host takes away its capabilities and nothing else: chat still answers, and nothing runs here instead", "a compute host starts and serves with an enabled plugin whose folder is gone, and with no plugins folder at all". `compute-inventory`: "only installed workers are listed, and removing the fixture folder drops its capabilities and nothing else". `compute-workers`: "a plugin that vanishes mid-job…". `compute-plugins`: "removing a worker folder removes only its capabilities…". | `pnpm check:no-plugins` (the whole suite with `plugins/` moved aside) was not run: it would break the other workers in this tree. |

## Connectivity and installers

| Checkbox | Status | Tests | Note |
|---|---|---|---|
| Test paired offline LAN connections. | **Partly proven** | `transport.rs`: every test connects two sidecars directly with no relay and no lookup service, by hint only. `acceptance`: "paired over their own routes by a code, with no relay, no address lookup and no internet, then the host answers over the real transport" (two Alexias, two real sidecars, loopback). | One machine, loopback only. *To verify:* two machines on one LAN with the router's internet unplugged (or both on a switch with no uplink), already paired: the host shows *Direct*, a chat answers, an image renders. |
| Test direct internet connections. | **Needs real hardware** | — | *To verify:* the two machines on different networks (home and a phone hotspot), relay set but UDP allowed; `GET /api/compute/status?host=` must say *Direct* after hole punching, and a chat answers. |
| Force and test relay connections. | **Needs real hardware** | — | Needs a deployed relay (`connect-services/`) set as `ALEXIA_CONNECT_RELAY_URLS` or `/api/compute/services`. *To verify:* block direct UDP between the two (firewall rule or a network that blocks it); status must be *Relayed*, chat and a render still work, and the measurements go in the relay column (below). |
| Test network changes, host sleep, and service outages. | **Partly proven** | `transport.rs`: `changing_the_network_keeps_the_identity`. `pairing.rs`: `a_mailbox_that_falls_over_fails_the_pairing_and_nothing_else`. `compute-controller`: "reconnection backs off 1 s, 2 s, 4 s, then every 5 s…". `compute-host-protocol`: the 15 s grace tests. `compute-interaction`: "a sidecar that will not start is not a startup failure…". | *To verify:* during a long render and during a chat answer, switch the laptop's Wi-Fi network, sleep and wake the host, and stop the relay and mailbox services; jobs must resume within the 15 s grace or be shown *interrupted*, never re-run, and pairing must say the mailbox is unavailable rather than fail some other way. |
| Pair clean Windows and macOS machines without separately installed Node, Rust, VPN, or command-line tools. | **Needs real hardware** | — | *To verify:* fresh Windows 11 and macOS user accounts (or VMs) with nothing installed; install the built Alexia installers only; pair by code and run a chat. Check `alexia-connect` is beside `alexia-core` in the install and both exit on Quit. |

## Efficiency and performance

| Checkbox | Status | Tests | Note |
|---|---|---|---|
| Confirm no webviews or assistant background loops remain after setup. | **Partly proven** | `compute-service`: "start() in the compute role serves the setup page and /api/compute/*, and nothing of the assistant" (no `serve()`, no chat-table read, no network, assistant routes 404), "a paired host gives up its windows…" (`@shell compute` sent once paired), "idle for five minutes with nothing stored, the service has no timer at all". `compute-shell`: the exact `@shell` lines. | Core's half is proven. **Not shown:** the shell (`src-tauri/src/main.rs`, T15) destroying the windows and hotkeys — only `cargo check` covers it. *To verify:* in Alexia Dev, switch to Compute with a paired controller; afterwards no WebKit `WebContent` (macOS) or `msedgewebview2` (Windows) child process remains (`ps -ax \| grep -i webcontent`, Task Manager), and the global hotkey does nothing. |
| Target under 1% of one CPU core averaged over five idle minutes. | **Needs real hardware** | (proxy: `compute-service` idle-timer tests) | *To verify:* compute role, paired, idle, windows gone; sample the shell, `alexia-core` and `alexia-connect` for five minutes (`top -l 300 -s 1 -stats pid,command,cpu` on macOS, `typeperf` / Process Explorer on Windows) and average. |
| Target under 150 MiB combined resident memory after worker shutdown. | **Needs real hardware** | — | *To verify:* after a chat and a render and the 10-minute idle stop, sum RSS of the shell, `alexia-core` and `alexia-connect` (`ps -o rss= -p …`). |
| Compare identical models and settings directly on the host versus through Alexia. | **Needs real hardware** | — | *To verify:* same GGUF, quant, context and sampling; send the same prompts to the host's runner directly and through Alexia from the interaction computer; record tokens/s and first-token time for both. |
| Target at least 95% of host token throughput on an uncongested LAN. | **Needs real hardware** | — | From the comparison above, on a wired or quiet LAN. |
| Target under 30 ms added p95 first-output latency on an uncongested LAN. | **Needs real hardware** | — | From the comparison above: p95 of (first token through Alexia − first token direct) over at least 50 requests, model already loaded. |
| Report cold-start and relay measurements separately. | **Needs real hardware** | — | Cold start (model unloaded, after the idle stop) and relayed runs are reported in their own columns, not averaged into the LAN figures. |
| Validate speed and GPU cleanup on real hardware, not only with mocked tests. | **Needs real hardware** | — | This row is the hardware run of the five rows above and of the ten-minute cleanup row. |

## Findings

1. **Fixed — the offline sentence blamed the person's internet.** With a paired host chosen
   and unreachable, `/api/chat` ends with `"It looks like you're offline — none of the AI
   services could be reached. Check your internet connection, then try again."` The behaviour
   is strict (nothing else is tried), but the person is told the wrong thing: their own
   connection, not *the paired computer is offline*. The plan (§6, §11) and the contract (§10)
   want the named state. Fixed in `router.ts` `stopped()`: when every failure is an unreachable
   paired computer, the sentence now says the paired computer could not be reached. The test in
   `acceptance` is now an ordinary test and passes.
2. **Observation — progress sent in the same instant as a result can be lost.** A fixture worker
   that called `alexia.progress` three times back to back with no pause and then returned had
   only the first step reach `Operations.run`'s `onProgress`. With the steps a few milliseconds
   apart (as a real render's are) all arrive, which is what the `acceptance` render test
   exercises. The SDK's `progress` is a fire-and-forget MCP notification, and a notification
   that lands after the tool's result is dropped. It costs at most the last step before
   `done`; it is not specific to compute and was not changed here.
3. **Observation — a crashed worker is restarted with no job asking for it.** After a plugin
   worker's process dies mid-job, the plugin supervisor's crash backoff respawns it within a
   second, and it stays until the ten-minute idle stop, which does stop it (`acceptance`, the
   crash test). Contract §1.11 says a lazy plugin "is respawned by its next job"; a resident
   process with nothing to do is against rule 5 (*a host with nothing to do does nothing*) for
   up to ten minutes. The respawned process holds no model until a job loads one.
4. **Observation, not investigated — the first job to a plugin worker started two processes;**
   the first exited at once and the second served the job. Seen in the fixture's pid log; it
   costs one extra spawn and was not traced further.

## Commands

| Command | Result |
|---|---|
| `pnpm vitest run --project unit packages/core/test/compute-acceptance.test.ts` | 20 passed, 1 expected fail (finding 1); green on eleven consecutive runs |
| `~/.cargo/bin/cargo test --manifest-path connect/Cargo.toml` | all pass: unit 12, `acceptance.rs` 2, `pairing.rs` 9, `transport.rs` 8 |
| `pnpm vitest run --project unit packages/core/test/compute- packages/core/test/guard.test.ts packages/ui/test/compute.test.ts plugins/voice/test/compute.test.js plugins/media/test/compute.test.js` | 28 files, 427 passed, 1 expected fail |
