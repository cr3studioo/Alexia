# Alexia iroh Integration Plan

## Agreed decisions

- [x] Use the existing Alexia Windows `.exe` and macOS `.dmg`.
- [x] Provide interaction and compute roles in the same application.
- [x] Keep agents, conversations, permissions, and user-facing tools on the interaction computer.
- [x] Support existing LLM, ComfyUI workflow, and local voice compute features.
- [x] Use temporary, single-use internet pairing codes.
- [x] Allow one interaction computer per compute host initially.
- [x] Stop idle workers and release their model memory after ten minutes.
- [x] Provide guided remote setup with explicit downloads.
- [x] Use Alexia-operated pairing and relay defaults, with self-host support.
- [x] Defer other applications’ API access.

## 1. Application roles and interface

- [x] Persist the installation’s role: interaction or compute.
- [x] Add role selection and switching to Alexia settings.
- [x] In Local mode, offer This computer, Paired computer, and Pair another computer.
- [x] Display the selected host’s models, capabilities, setup requirements, and connection state.
- [x] Perform model downloads and hardware-fit checks on the selected host.
- [x] Keep document handling on the interaction computer; route its model requests to the selected compute destination.
- [x] Expose only capabilities supported by installed workers, workflows, and nodes.
- [x] Preserve existing chats when changing roles.
- [x] Wait for active jobs to finish or be explicitly cancelled before changing roles.
- [x] Stop the previous service and workers before restarting in the new role.

## 2. Minimal compute service

- [x] Add a dedicated TypeScript compute entrypoint.
- [x] Avoid initializing the normal assistant server in compute mode.
- [x] After setup, destroy chat and overlay webviews and unregister assistant hotkeys.
- [x] Retain a minimal tray/menu-bar control for status, pause, unpair, role switching, and quit.
- [x] Do not start chat history, agents, memory maintenance, provider polling, background model tests, update checks, or idle hardware sampling.
- [x] Retain lightweight transport maintenance and supervision of active jobs.
- [x] Probe hardware during setup, preparation, and job admission.
- [x] Make connection and inventory updates event-driven.
- [x] Check for and apply updates only when explicitly requested and while idle.

## 3. Native transport

- [x] Add a standalone Rust `alexia-connect` sidecar.
- [x] Initially pin iroh to version 1.3.0.
- [x] Limit native responsibilities to encrypted connectivity, endpoint identity, pairing cryptography, and stream forwarding.
- [x] Keep scheduling, permissions, setup, and worker policy in TypeScript.
- [x] Use authenticated loopback communication with per-launch secrets.
- [x] Forward only registered compute operations to the dedicated host service.
- [x] Reject compute traffic from endpoints outside the paired-device allowlist.
- [ ] Prefer direct connections and retain encrypted relay fallback.
- [x] Display Direct, Relayed, or Offline connection status.
- [x] Use independent QUIC streams for jobs and artifacts.
- [x] Bound buffering and propagate backpressure.
- [x] Document the native transport exception in Alexia’s architecture record.
- [x] Preserve the thin Tauri shell and plugin-removal invariants.

Reference: https://docs.rs/iroh/1.3.0/iroh/

## 4. Secure pairing

- [x] Reuse Magic Wormhole’s authenticated mailbox exchange for bootstrap.
- [x] Use an Alexia-specific application identifier and separate mailbox service.
- [x] Use iroh for compute traffic after pairing.
- [x] Generate a mailbox number plus four random words.
- [x] Expire each code after five minutes.
- [x] Permit one pairing attempt per code.
- [x] Invalidate codes after success, authentication failure, cancellation, or expiry.
- [x] Require a fresh code after a failed attempt.
- [x] Exchange endpoint identities and connection hints inside the authenticated pairing channel.
- [x] Prove possession of the exchanged identities over iroh before persisting trust.
- [x] Store endpoint private keys in the OS keychain under native-process custody.
- [x] Expose no operation that returns private keys to plugins.
- [x] Store nonsecret pairing records separately.
- [x] Require explicit unpairing before replacing the controller.
- [x] Close connections and cancel jobs immediately when a controller is revoked.
- [x] Exclude codes and sensitive pairing messages from logs.
- [x] Apply server-side attempt, connection, and message-size limits.

Reference: https://magic-wormhole.readthedocs.io/en/latest/welcome.html

## 5. Connectivity services

- [ ] Provide Alexia-operated mailbox and iroh relay defaults.
- [x] Keep connectivity services separate from the plugin registry.
- [x] Publish reproducible self-host deployment files and configuration instructions.
- [x] Make service addresses configurable.
- [ ] Publish paired-host connection information through iroh address lookup.
- [ ] Use LAN discovery only as a connection hint, never as authorization.
- [ ] Support direct offline LAN connections between already-paired computers.
- [x] Explain that initial internet-code pairing requires the mailbox service.
- [x] Keep prompts, outputs, and pairing secrets out of service logs.
- [ ] Monitor availability, connection failures, relay traffic, and abuse limits.
- [ ] Validate deployed service defaults before general release.
- [x] Document that service hosting costs belong to the operator.

## 6. Execution targets and routing

- [x] Introduce `ExecutionTarget = { hostId: 'this' | string, modelId: string }`.
- [x] Use host-qualified catalog identities to prevent model-name collisions.
- [x] Translate catalog identities into native engine model IDs at the inference boundary.
- [x] Migrate existing saved model selections to `hostId: 'this'`.
- [x] Extend mode transitions with the selected target and connection/setup/loading status.
- [x] Permit the explicitly selected owned host in Local routing.
- [x] Avoid treating a loopback bridge URL as proof that inference runs on this computer.
- [x] Reuse the existing provider client and SSE parser.
- [x] Return an internal authenticated loopback bridge and releasable lease from remote provider preparation.
- [x] Preserve reasoning, tool calls, usage, image inputs, parameters, streaming, and cancellation.
- [x] Never silently switch hosts, models, or cloud providers.

## 7. Compute protocol and plugin contract

- [x] Add a versioned protocol for handshake, inventory, preparation, and job submission.
- [x] Include progress/output, cancellation, artifact transfer, and job-status operations.
- [x] Add an optional compute-worker declaration to plugin manifests.
- [x] Add matching SDK methods and lifecycle hooks.
- [x] Discover workers generically without importing or naming individual plugins in core.
- [x] Expose explicit compute operations rather than unrestricted remote plugin execution.
- [x] Removing a compute plugin must remove its capabilities without breaking the service.

## 8. Workers and GPU scheduling

- [x] Reuse existing llama.cpp and MLX runners.
- [x] Prepare the selected chat model on selection.
- [x] Reacquire the model if its idle timeout has elapsed.
- [x] Adapt existing media and voice packages into compute workers.
- [x] Keep microphone capture, playback, local file access, prompt planning, and permission checks on the interaction computer.
- [x] Start workers on demand.
- [x] Stop Alexia-owned workers ten minutes after their last job or preparation lease ends.
- [x] Release model memory when workers stop.
- [x] Allow one heavy compute job at a time initially.
- [x] Show a FIFO queue.
- [x] Release idle workers before another backend needs their memory.
- [x] Run ComfyUI in a dedicated Alexia-owned process.
- [x] Never cancel or stop a separately running personal ComfyUI instance.

## 9. Guided remote setup

- [x] List missing host runtimes, models, and dependencies.
- [x] Show download sizes before installation.
- [x] Require explicit installation actions.
- [x] Reuse existing download and installation flows where available.
- [x] Detect and configure an existing ComfyUI installation.
- [x] Provide appropriate installation instructions when ComfyUI is absent.
- [x] Keep existing remote model and workflow setup available.
- [x] ~~Do not present a full cross-platform ComfyUI installer as part of this integration.~~ Reversed 2026-10-03 by the owner: Alexia installs its own ComfyUI on the computer that renders (`plugins/media/install.js`; Windows + NVIDIA portable build, pinned; elsewhere an instructions link), into the plugin's folder, and never touches a ComfyUI the person installed.

## 10. Files and artifacts

- [x] Transfer approved inputs into job-scoped host directories.
- [x] Return artifact IDs, sizes, hashes, and streamed bytes.
- [x] Import outputs into the interaction computer’s normal storage.
- [x] Avoid exposing host filesystem paths.
- [x] Retain completed artifacts for retrieval for up to 24 hours.
- [x] Delete temporary host copies after successful transfer acknowledgment.
- [x] Clean up expired artifacts and abandoned job inputs.

## 11. Cancellation and recovery

- [x] Cancel queued jobs immediately.
- [x] Propagate active cancellation to the owning worker.
- [x] Allow a 15-second reconnect grace period after losing the control session.
- [x] Cancel unfinished jobs when that grace period expires.
- [x] Reconnect using existing job IDs to report outcomes.
- [x] Never automatically resubmit interrupted generation.
- [x] Never replay tool calls automatically.
- [x] Display explicit offline, busy, incompatible-version, setup-required, and worker-failure states.
- [x] Ensure quitting stops all Alexia-owned services and workers.

## 12. Packaging and rollout

- [ ] Include required Alexia binaries in the existing Windows and macOS installers.
- [ ] Preserve signing, macOS notarization, updater verification, and sidecar cleanup.
- [x] Implement transport and pairing first.
- [x] Implement minimal compute mode and remote LLM routing second.
- [x] Add the generic worker contract and media/voice adapters third.
- [x] Add guided setup and artifact handling fourth.
- [ ] Complete installer and connectivity-service deployment integration.
- [ ] Run existing repository checks, native transport tests, and installer smoke checks.
- [ ] Require two-machine hardware validation before release.

## 13. Acceptance tests

### Pairing and authorization

- [x] Verify code expiry and failed-attempt invalidation.
- [x] Reject replay, identity substitution, and unauthorized requests.
- [x] Test concurrent pairing attempts.
- [ ] Verify pairing survives application restarts.
- [x] Verify revocation closes connections and cancels jobs.

### Routing and setup

- [x] Distinguish identical model names on different hosts.
- [x] Use remote hardware for memory-fit decisions.
- [x] Download remote models only onto the remote host.
- [x] Verify saved-selection migration.
- [ ] Verify strict target selection and offline behavior.

### Compute jobs

- [x] Stream text, reasoning, tool calls, and usage correctly.
- [x] Preserve image inputs and inference parameters.
- [ ] Verify voice input/output transfer.
- [ ] Verify ComfyUI progress and artifact delivery.
- [x] Test queue cancellation and active cancellation.
- [x] Test disconnect/reconnect and worker crashes.
- [ ] Verify ten-minute worker and GPU-memory cleanup.
- [x] Verify plugin removal does not break chat inference or compute startup.

### Connectivity and installers

- [ ] Test paired offline LAN connections.
- [ ] Test direct internet connections.
- [ ] Force and test relay connections.
- [ ] Test network changes, host sleep, and service outages.
- [ ] Pair clean Windows and macOS machines without separately installed Node, Rust, VPN, or command-line tools.

### Efficiency and performance

- [ ] Confirm no webviews or assistant background loops remain after setup.
- [ ] Target under 1% of one CPU core averaged over five idle minutes.
- [ ] Target under 150 MiB combined resident memory after worker shutdown.
- [ ] Compare identical models and settings directly on the host versus through Alexia.
- [ ] Target at least 95% of host token throughput on an uncongested LAN.
- [ ] Target under 30 ms added p95 first-output latency on an uncongested LAN.
- [ ] Report cold-start and relay measurements separately.
- [ ] Validate speed and GPU cleanup on real hardware, not only with mocked tests.
