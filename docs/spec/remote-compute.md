# Remote compute: the contract

> **One Alexia talks to you; another, on a computer you own, does the heavy work for it.**
> The conversation, the agents, the permissions and the tools stay on the *interaction*
> computer. Models, image workflows and local voice run on a paired *compute host*. Nothing is
> ever sent to a host, a model or a cloud provider that somebody did not choose.
>
> This document turns sections 1–11 of
> [`alexia-iroh-integration-plan.md`](../../alexia-iroh-integration-plan.md) into modules,
> signatures and seams that can be built in parallel. The shared types already exist:
> [`packages/core/src/compute/types.ts`](../../packages/core/src/compute/types.ts) and
> [`protocol.ts`](../../packages/core/src/compute/protocol.ts). **Where this document and those
> two files disagree, the files win** — they are compiled and tested.
>
> Companions: [`manifest.md`](./manifest.md) · [`wire-protocol.md`](./wire-protocol.md) ·
> [`storage.md`](./storage.md) · [`invariants.md`](./invariants.md) ·
> [`connect/README.md`](../../connect/README.md) (the native sidecar's own API, written by its
> author) · background in [`remote-gpu-research.md`](../remote-gpu-research.md)

**Status: design.** Only the two type modules and their test exist. Everything else below is
a module to be written, and every path is a proposal that the work breakdown in §9 assigns.

Where each part of the brief is answered: module map §1 · seams in existing files §2 · the
protocol §3 · the plugin compute-worker contract §4 · persistence and migration §5 · HTTP
routes §6 · sidecar requirements §7 · Rust budget §8 · work breakdown §9 · cancellation and
recovery §10 · open decisions §11.

Not designed here, on purpose: API access for other applications (deferred by the plan),
more than one interaction computer per host, and packaging and service deployment (plan
sections 12 and 13), which appear only as tasks in §9.

---

## 0. The shape, in one page

```text
 INTERACTION COMPUTER                                   COMPUTE HOST
 ┌──────────────────────────────────┐                 ┌──────────────────────────────────┐
 │ serve.ts (assistant, unchanged)  │                 │ compute/service.ts (no assistant) │
 │  router ── provider.chat()       │                 │  hostProtocol ── scheduler        │
 │              │ prepare()         │                 │        │            │             │
 │  compute/bridge  (loopback HTTP) │                 │   artifacts     workers           │
 │  compute/controller (sessions)   │                 │                 ├ text runner     │
 │  compute/connect  ───────────────┼── loopback ──┐  │                 │ (LocalRunners)  │
 └──────────────────────────────────┘              │  │                 └ plugin workers  │
            alexia-connect (Rust) ══ iroh QUIC ══ alexia-connect (Rust) ── loopback ──┘   │
                                                   └──┴──────────────────────────────────┘
```

Five rules everything else follows from.

1. **The sidecar moves bytes and proves identity; TypeScript decides.** `alexia-connect`
   owns encrypted connectivity, endpoint identity, pairing cryptography and stream
   forwarding. Scheduling, permissions, setup, worker policy and every message below are
   TypeScript. (Decision D208.)
2. **Four streams, and nothing else crosses.** `control`, `infer`, `job`, `artifact`
   (`STREAM_KINDS`). There is no "run this" stream and no remote plugin call.
3. **A target is a host and a model, and it is strict.** `ExecutionTarget = { hostId, modelId }`.
   A failure on the selected target stops with a named state. It never becomes another host,
   another model or a cloud provider.
4. **Core names no plugin.** Workers are found by a manifest declaration and called by
   capability. Deleting a compute plugin removes its capabilities from the inventory and
   nothing else.
5. **A host with nothing to do does nothing.** No timers except the idle stop and the
   reconnect grace, both armed by an event and cleared by one.

Constants, all exported from `types.ts`: `PAIRING_CODE_MS` 5 min · `IDLE_STOP_MS` 10 min ·
`RECONNECT_GRACE_MS` 15 s · `ARTIFACT_RETENTION_MS` 24 h. From `protocol.ts`:
`COMPUTE_PROTOCOL_VERSION` 1 · `FRAME_MAX_BYTES` 1 MiB.

---

## 1. Module map

Every new module is under `packages/core/src/compute/` unless a path says otherwise. Each
lists the file that owns it, what it is for, and what it exports. Imports of existing code
are named so the dependency direction is visible: **nothing in `compute/` imports
`serve.ts`**, and `serve.ts` imports only `compute/interaction.ts`, `compute/types.ts` and
`compute/target.ts`.

### 1.1 `types.ts`, `protocol.ts` — shared vocabulary (exist)

Pure types and helpers. See the files. The ones other sections lean on:

```ts
// types.ts
export const THIS_HOST = 'this'
export interface ExecutionTarget { hostId: 'this' | string; modelId: string }
export const REMOTE_PROVIDER = 'remote'
export function qualify(target: ExecutionTarget): string          // '@<hostId>/<modelId>', or modelId on this computer
export function parseCatalogId(id: string): ExecutionTarget
export const isRemoteId: (id: string) => boolean
export function migrateSelection(saved: unknown): ExecutionTarget | undefined
export type Role = 'interaction' | 'compute'
export const roleOf: (saved: unknown) => Role
export type ConnectionState = 'direct' | 'relayed' | 'offline'
export interface PairedHost { id; name; endpointId; peerRole; pairedAt; lastSeenAt?; platform?; appVersion? }
export type ComputeErrorCode = 'offline' | 'busy' | 'incompatible-version' | 'setup-required' | 'worker-failure'
  | 'unpaired' | 'cancelled' | 'interrupted' | 'not-found' | 'refused' | 'expired'
export class ComputeError extends Error { code: ComputeErrorCode; failure(): ComputeFailure }
export type JobState = 'queued' | 'preparing' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export interface JobSnapshot, QueueSnapshot, ArtifactRef, SetupRequirement, HostInventory, HostView, TargetStatus, PairingStatus

// protocol.ts
export const COMPUTE_PROTOCOL_VERSION = 1
export function negotiate(theirs: ProtocolRange, mine?: ProtocolRange): number | undefined
export const STREAM_KINDS = ['control', 'infer', 'job', 'artifact'] as const
export function encodeFrame(message: unknown): Uint8Array
export function splitFrame(buffer: Uint8Array): { frame: unknown; rest: Uint8Array } | undefined
export type StreamOpen, ControlOpened, ControlRequest, ControlResponse, ControlEvent, JobSubmit, JobEvent, InferHead, ArtifactPut, Lease
export interface ControlCalls   // method → { params, result }
```

### 1.2 `role.ts` — role persistence and switching

The installation's role is one kv value. Switching is a small serialized lifecycle, shaped
like `ModeTransitions`: wait for work to finish or be cancelled on request, stop the
service and its workers, write the role, ask to be restarted. Chats are untouched because
nothing here opens them.

```ts
import type { Store } from '../store.js'
import type { Role } from './types.js'

export const ROLE_KEY = 'compute_role'                              // kv, namespace CORE
export function readRole(store: Pick<Store, 'kvGet'>): Role         // roleOf(kvGet(CORE, ROLE_KEY))

export interface RoleSwitch {
  target: Role
  phase: 'waiting' | 'stopping' | 'restarting' | 'failed'
  message: string
  /** How many jobs or tasks it is waiting on, while `waiting`. */
  active?: number
}
export interface RoleSwitcherOptions {
  store: Pick<Store, 'kvGet' | 'kvSet'>
  /** Jobs running or queued (compute role), or a task, a reply or a model operation (interaction role). */
  active(): number
  /** Cancel everything `active()` counts. Called only when the request said `cancel: true`. */
  cancelActive(): Promise<void>
  /** Stop the running service and every Alexia-owned worker. Resolves once nothing is left. */
  stop(): Promise<void>
  /** Come back in the role just written: `shell.relaunch()` under the app, `process.exit(0)` otherwise. */
  restart(): void
}
export class RoleSwitcher {
  constructor(options: RoleSwitcherOptions)
  status(): RoleSwitch | undefined
  /** Refused with `{ ok: false }` when `target` is the current role or a switch is already under way. */
  request(target: Role, options?: { cancel?: boolean }): { ok: boolean; note: string }
}
```

Order inside `request`: `waiting` (poll `active()` every 100 ms, as `ModeTransitions` polls `busy()`) →
`stopping` (`stop()`) → write `ROLE_KEY` → `restarting` (`restart()`). The role is written
*after* the stop, so a crash mid-switch restarts in the old role with nothing half-stopped.

### 1.3 `target.ts` — the selected target, its migration, and catalog rows

```ts
import type { Model } from '../catalog.js'
import type { Store } from '../store.js'
import type { ExecutionTarget, HostModel, HostView } from './types.js'

export const TARGET_KEY = 'local_target'                            // kv, namespace CORE
/** The saved target. Reads TARGET_KEY; if absent, migrates `last_local_model` and writes the result. */
export function selectedTarget(store: Pick<Store, 'kvGet' | 'kvSet'>): ExecutionTarget | undefined
/** Writes TARGET_KEY, and `last_local_model` too when the target is on this computer. */
export function rememberTarget(store: Pick<Store, 'kvSet'>, target: ExecutionTarget): void
/** The host everything placed local runs on: the selected target's, or 'this'. */
export function selectedHost(store: Pick<Store, 'kvGet' | 'kvSet'>): string
/** A host's model as a catalog row: id `qualify(...)`, provider REMOTE_PROVIDER, tier T0, `host` set. */
export function remoteModel(hostId: string, model: HostModel): Model
/** Rows for the selected host only, and only while its inventory is known. */
export function remoteModels(views: readonly HostView[], selected: string): Model[]
```

Identity rules (§5 has the migration):

- A catalog id is what `Model.id`, `pins.model` and `pins.order` carry. On this computer it is
  the id it always was. On a paired host it is `@<hostId>/<modelId>`.
- `Model.name` for a remote row is the host's model name; the host's display name is drawn
  beside it by the screen from `Model.host`, never baked into the name.
- **Translation to the engine's id happens once, at the inference boundary**: the remote
  provider's `prepare()` returns `model: target.modelId`, and `chat()` puts that on the wire
  (§2, `provider.ts`). The host never sees a qualified id.

### 1.4 `hosts.ts` — paired-host records (nonsecret)

```ts
import type { Store } from '../store.js'
import type { PairedHost, Role } from './types.js'

export const HOSTS_KEY = 'compute_hosts'                            // kv, namespace CORE: PairedHost[]
export function mintHostId(random?: (bytes: number) => Uint8Array): string   // 12 chars of [a-z0-9]

export class Hosts {
  constructor(store: Pick<Store, 'kvGet' | 'kvSet'>, role: Role)
  list(): PairedHost[]
  get(id: string): PairedHost | undefined
  byEndpoint(endpointId: string): PairedHost | undefined
  /** Throws ComputeError('refused') in the compute role when a controller is already paired. */
  add(peer: Omit<PairedHost, 'id' | 'pairedAt'>, at?: number): PairedHost
  touch(id: string, change: Partial<Pick<PairedHost, 'name' | 'lastSeenAt' | 'platform' | 'appVersion'>>): void
  remove(id: string): PairedHost | undefined
  /** Every paired endpoint id: what the sidecar is told to allow, and nothing else. */
  allowlist(): string[]
  onChange(listener: () => void): () => void
}
```

No key material is stored here or anywhere in TypeScript. `endpointId` is a public identity.
The record is written **only after** the sidecar reports that both sides proved possession
of the exchanged identities over iroh.

### 1.5 `connect.ts` — the TypeScript client for `alexia-connect`

The only module that knows the sidecar's loopback API. It spawns the binary, mints the
per-launch secret, and presents everything else in this document with the interface below.
**Its implementation follows `connect/README.md`; this interface is what the rest of core
may assume.** If the README's API cannot satisfy a method, that is a finding for the
coordinator, not something to paper over in a caller.

```ts
import type { Duplex } from 'node:stream'
import type { ConnectionState, Role } from './types.js'
import type { StreamKind } from './protocol.js'

export interface ConnectOptions {
  dataDir: string
  role: Role
  /** The endpoints allowed from the first moment. Kept current with `allow()`. */
  allow: readonly string[]
  /** Overrides for the Alexia-operated defaults (plan §5). Absent means the built-in defaults. */
  services?: { relay?: string; mailbox?: string }
  /** Where the binary is. Default: `binaryPath()`. */
  binary?: string
  log?(line: string): void
}
/** What pairing exchanged inside its authenticated channel, plus the proven endpoint. */
export interface PairedPeer { endpointId: string; name: string; role: Role; platform: string; appVersion: string }

export interface Connect {
  /** This installation's public endpoint identity. */
  identity(): Promise<string>
  /** Replace the allowlist. An endpoint dropped from it has its connections closed before this resolves. */
  allow(endpointIds: readonly string[]): Promise<void>
  /** Open one stream of a registered kind to an allowed peer. Rejects with ComputeError('offline' | 'unpaired'). */
  open(endpointId: string, kind: StreamKind, signal?: AbortSignal): Promise<Duplex>
  /** Streams opened by an allowed peer. One handler; the sidecar never delivers any other peer's. */
  accept(handler: (stream: Duplex, from: { endpointId: string; kind: StreamKind }) => void): void
  state(endpointId: string): ConnectionState
  onState(listener: (endpointId: string, state: ConnectionState) => void): () => void
  /** Open a pairing and show its code. `done` settles once: the proven peer, or ComputeError('expired' | 'cancelled' | 'refused'). */
  pairOpen(me: Omit<PairedPeer, 'endpointId'>, signal: AbortSignal): Promise<{ code: string; expiresAt: number; done: Promise<PairedPeer> }>
  /** Join a pairing by its code. One attempt: a failure means a fresh code. */
  pairJoin(code: string, me: Omit<PairedPeer, 'endpointId'>, signal: AbortSignal): Promise<PairedPeer>
  close(): Promise<void>
}

/** Beside the running executable in the app (`alexia-connect[.exe]`), or `ALEXIA_CONNECT_BIN` in a checkout. Undefined when absent. */
export function binaryPath(env?: NodeJS.ProcessEnv, execPath?: string): string | undefined
/** Spawn, hand over the per-launch secret, wait for readiness. Rejects with ComputeError('setup-required') when there is no binary. */
export function connect(options: ConnectOptions): Promise<Connect>
/** For tests and for `pnpm dev` with no binary built: two in-process ends joined by pipes, same interface. */
export function memoryConnect(): { a: Connect; b: Connect }
```

Rules this module keeps:

- The secret is 32 random bytes, minted per spawn, handed to the child down a pipe only that
  child shares, and never written to disk, a log or an environment variable.
- A `Duplex` returned by `open`/`accept` carries backpressure end to end: a `write()` that
  returns `false` is the far side not reading. Nothing in `connect.ts` buffers beyond one
  stream's high-water mark.
- The child is killed in `close()`, and exits on its own when its parent's pipe closes.
- The pairing code and everything inside the pairing channel are never passed to `log`.
- `memoryConnect()` is what makes every other module testable with no Rust built.

### 1.6 `service.ts` and `../entry.ts` — the compute entrypoint

`entry.ts` becomes the bundle's entry (today it is `serve.ts`). It reads the role and starts
one of two services. **In the compute role `serve()` is never called**, so none of what it
constructs exists: no catalog polling, no agents, no model tests, no trace, no chat routes.

```ts
// packages/core/src/entry.ts
import type { SecretStore } from './secrets.js'
import type { Role } from './compute/types.js'
export { serve } from './serve.js'
export { fromShell } from './secrets.js'
export interface Started { url: string; role: Role; close(): Promise<void> }
/** Opens the store just long enough to read the role, then starts that role's service on `port`. */
export function start(options?: { port?: number; secrets?: SecretStore; dataDir?: string; uiDir?: string }): Promise<Started>
```

```ts
// packages/core/src/compute/service.ts
import type { SecretStore } from '../secrets.js'
import type { Connect } from './connect.js'
import type { Shell } from './shell.js'

export interface ComputeServeOptions {
  dataDir?: string
  uiDir?: string
  port?: number
  secrets?: SecretStore
  pluginsDir?: string
  /** Injectable for tests: `memoryConnect().b`. */
  connect?: Connect
  shell?: Shell
}
export interface ComputeServing { url: string; token: string; close(): Promise<void> }
export function computeServe(options?: ComputeServeOptions): Promise<ComputeServing>
```

What `computeServe` constructs, and nothing more: `Store` (kv only) · `LlamaServer`,
`MlxServer`, `LocalRunners`, `LocalModels` (the existing ones, for the host's own picker
operations) · `Plugins` with `sample` absent and `roots` empty, never started eagerly ·
`Hosts` · `Connect` · `Artifacts` · `Scheduler` · `Workers` · `Inventory` · `HostProtocol` ·
`RoleSwitcher` · one loopback HTTP listener that serves the setup page and the `/api/compute/*`
routes of §6 through `api.ts`, with the same token and `Host` header check `serve.ts` uses.

What it must not start: chat history readers, the agent loop, memory maintenance, provider
polling, background model tests, update checks, hardware sampling on a timer.

`close()` order: `HostProtocol.close()` (says `bye`) → `Scheduler.close()` (cancels jobs,
stops every worker) → `LocalModels.close()` → `LocalRunners.stop()` → `Plugins.stop()` →
`Connect.close()` → HTTP → `Store.close()`. Quitting stops everything Alexia started.

### 1.7 `shell.ts` — talking to the desktop shell without a webview

In the compute role the windows are destroyed, so the page can no longer relay tray state or
receive tray clicks. Core and the shell already share two pipes; this module is the only
user of them after the vault handshake. Lines are plain text so the shell needs no parser.

```ts
export type TrayAction = 'pause' | 'resume' | 'unpair' | 'role' | 'window'
export interface Shell {
  /** Windows may go: setup is finished. The shell destroys them, unregisters hotkeys, and shows the compute menu. */
  computeReady(status: string): void
  /** The one status line in the tray menu and tooltip: `Paired with MacBook · Idle`. */
  status(line: string, paused: boolean): void
  /** Restart the whole app (windows included). Used by a role switch and by *Open window*. */
  relaunch(): void
  onTray(listener: (action: TrayAction) => void): () => void
}
/** Under the app (`ALEXIA_TAURI`): writes `@shell …` lines to stdout, reads `tray …` lines from stdin. */
export function shellPipe(output?: NodeJS.WritableStream, input?: NodeJS.ReadableStream): Shell
/** Run from a checkout: does nothing, and `relaunch` exits the process. */
export function noShell(): Shell
```

Core → shell, one per line on stdout: `@shell compute <status>` · `@shell status <0|1> <status>`
· `@shell relaunch`. Shell → core on stdin after the vault line: `tray <action>`. A window is
kept, or brought back by `tray window`, by core setting kv `compute_window` and relaunching:
the app always starts with its windows, and they go only when core says `computeReady`.

### 1.8 `controller.ts` — sessions from the interaction computer

One control session per paired host, opened on demand (selection, a host-list read, a job)
and kept while it is in use. Owns reconnection and the cached `HostView`.

```ts
import type { Duplex } from 'node:stream'
import type { Connect } from './connect.js'
import type { Hosts } from './hosts.js'
import type { ControlCalls, ControlEvent, ControlMethod, StreamOpen } from './protocol.js'
import type { HostView } from './types.js'

export interface ControllerOptions {
  connect: Connect
  hosts: Hosts
  name: string
  appVersion: string
  /** Jobs to name in `Hello.resume`: what `RemoteJobs` still wants the outcome of. */
  resume?(hostId: string): string[]
}
export class Controller {
  constructor(options: ControllerOptions)
  views(): HostView[]
  view(hostId: string): HostView | undefined
  onChange(listener: (hostId: string) => void): () => void
  onEvent(listener: (hostId: string, event: ControlEvent) => void): () => void
  /** Open the session if it is not open. Throws ComputeError: offline, unpaired, incompatible-version, busy. */
  ensure(hostId: string, signal?: AbortSignal): Promise<void>
  call<M extends ControlMethod>(hostId: string, method: M, params: ControlCalls[M]['params'], signal?: AbortSignal): Promise<ControlCalls[M]['result']>
  /** Open an `infer`, `job` or `artifact` stream and write its open frame. The caller reads what follows. */
  stream(hostId: string, open: Exclude<StreamOpen, { stream: 'control' }>, signal?: AbortSignal): Promise<Duplex>
  /** Close the session and stop reconnecting. Used by unpair. */
  drop(hostId: string): Promise<void>
  close(): Promise<void>
}
```

`HostView.failure` is how the five named states reach the screen: `offline` from
`Connect.state`, `incompatible-version` from a failed `negotiate`, `busy` and
`setup-required` and `worker-failure` from the host's own answers. A host that is offline
stays in `views()` with its last inventory and its reason; it does not disappear.

Reconnection: when a session drops, the controller retries with backoff (1 s, 2 s, 4 s, then
every 5 s while something is waiting on that host; not at all when nothing is). Each retry is
a fresh `Hello` carrying `resume`. It never resubmits anything (§10).

### 1.9 `hostProtocol.ts` — the protocol's host end

Accepts streams from `Connect.accept`, checks that the peer is the paired controller, and
dispatches. It holds no policy of its own: admission is the scheduler's, files are the
artifact store's, operations are the workers'.

```ts
export interface HostProtocolOptions {
  connect: Connect
  hosts: Hosts
  scheduler: Scheduler
  workers: Workers
  artifacts: Artifacts
  inventory: Inventory
  /** The host's own picker operations: `LocalModels`, called by name from HOST_MODEL_OPS. */
  models: HostModels
  name: string
  appVersion: string
}
export interface HostModels { call(op: HostModelOp, args: Record<string, unknown>): Promise<unknown> }
export class HostProtocol {
  constructor(options: HostProtocolOptions)
  start(): void
  /** The tray's pause: jobs queue and none starts; the controller sees `QueueSnapshot.paused`. */
  pause(paused: boolean): void
  /** Unpair from this side: `bye unpaired`, cancel every job, drop the allowlist entry, forget the record. */
  revoke(): Promise<void>
  /** One line for the tray: who is paired, and idle, working or paused. */
  onStatus(listener: (line: string, paused: boolean) => void): () => void
  close(reason?: ByeReason): Promise<void>
}
```

Per stream kind:

| Stream | First frame | Host does |
|---|---|---|
| `control` | `{ stream: 'control', hello }` | `negotiate`; refuse `incompatible-version`; answer `welcome` with inventory, queue and the state of every `resume` job; then serve `ControlRequest`s and push `ControlEvent`s. A second control session from the same controller replaces the first. |
| `infer` | `{ stream: 'infer', jobId, leaseId, bodyBytes }` | Read exactly `bodyBytes`. Admit a `chat` job through the scheduler. Once the text worker is ready, `POST` the body to the runner's loopback `/chat/completions` with the runner's key, write `InferHead`, then pipe the response bytes with `stream.pipeline`. Stream closed by the controller ⇒ abort the runner request. |
| `job` | `{ stream: 'job', submit }` or `{ attach, after? }` | Submit is idempotent on `jobId`. Write `JobEvent`s in `seq` order until `done`. A `{ type: 'cancel' }` frame cancels. Closing the stream does **not** cancel: the job belongs to the session, not the stream. |
| `artifact` | `{ put }` or `{ get, offset? }` | `put`: read `bytes`, verify size and SHA-256, answer `stored` or `refused`. `get`: write `ArtifactHead`, then the bytes from `offset`. |

Any other first frame, a frame over `FRAME_MAX_BYTES`, or a non-`control` stream with no open
control session closes the stream. Nothing is logged but the stream kind and the reason.

### 1.10 `scheduler.ts` — one heavy job at a time

Runs on the host. Pure policy over injected timers, so every rule below is a unit test.

```ts
import type { ComputeFailure, JobKind, JobProgress, JobSnapshot, JobWeight, QueueSnapshot, ArtifactRef } from './types.js'

/** A backend Alexia started that holds memory: the text runners, or one plugin worker. */
export interface WorkerHandle {
  readonly id: string
  /** Whether it holds model memory right now. */
  loaded(): boolean
  /** Stop it and release its memory. Must be safe to call when already stopped. */
  stop(): Promise<void>
}
export interface JobSpec { id: string; kind: JobKind; weight: JobWeight; label: string; worker: string }
export interface Admission {
  readonly job: JobSnapshot
  /** Aborted by cancel, by revocation, and by the reconnect grace running out. */
  readonly signal: AbortSignal
  /** Resolves when it is this job's turn and every other idle worker has been stopped. */
  readonly turn: Promise<void>
  progress(progress: JobProgress): void
  finish(outcome: { state: 'succeeded'; artifacts?: ArtifactRef[] } | { state: 'failed' | 'cancelled' | 'interrupted'; failure?: ComputeFailure }): void
}
export interface SchedulerOptions {
  idleMs?: number                    // IDLE_STOP_MS
  keepFinishedMs?: number            // ARTIFACT_RETENTION_MS
  now?(): number
  timer?(fn: () => void, ms: number): { clear(): void }
}
export class Scheduler {
  constructor(options?: SchedulerOptions)
  register(worker: WorkerHandle): void
  unregister(workerId: string): Promise<void>
  /** Idempotent on `spec.id`: a known id returns the admission it already has, or throws ComputeError('refused') once finished. */
  submit(spec: JobSpec): Admission
  cancel(jobId: string): JobSnapshot
  cancelAll(state: 'cancelled' | 'interrupted', failure?: ComputeFailure): Promise<void>
  status(jobId: string): JobSnapshot | undefined
  queue(): QueueSnapshot
  pause(paused: boolean): void
  /** A preparation lease on a worker. The returned function ends it. */
  hold(workerId: string): () => void
  idle(): boolean
  onChange(listener: () => void): () => void
  onJob(listener: (job: JobSnapshot) => void): () => void
  close(): Promise<void>
}
```

The rules, each of which is an acceptance test:

1. **One heavy job runs.** Heavy jobs wait in one FIFO queue across all workers and kinds.
   Light jobs (`setup` downloads, probes) start at once, at most two together.
2. **A queued job cancels immediately**: it leaves the queue in the same tick with state
   `cancelled`. A running one moves to `cancelling`, its `signal` aborts, and it becomes
   `cancelled` when its worker calls `finish`.
3. **Before a heavy job's turn resolves, every *other* registered worker that is `loaded()`
   is stopped.** With one heavy job at a time those workers are idle by construction, so
   this is "release idle workers before another backend needs their memory".
4. **Idle stop.** When a worker has no running job and no hold, a single timer is armed for
   `idleMs`. A new job or hold clears it. When it fires, `stop()` is called. A hold is also
   idle time: a lease keeps a model *selected*, not *loaded for ever*, so the clock runs from
   the later of the last job's end and the hold's start, and the hold ends when it fires.
5. **Pause** stops jobs from starting and changes nothing that is running.
6. **Finished jobs are remembered for `keepFinishedMs`**, at most 200, so a reconnect can be
   told the outcome. A host restart loses them, and the controller is told `interrupted`.

### 1.11 `workers.ts` — the text runner and the plugin workers, as one kind of thing

```ts
import type { LocalRunners, RunnerLease } from '../localRunners.js'
import type { Plugins } from '../plugins.js'
import type { JobOutput } from './protocol.js'
import type { WorkerHandle } from './scheduler.js'
import type { HostCapability, HostModel, JobProgress, SetupRequirement } from './types.js'

export interface JobIo {
  signal: AbortSignal
  /** The job's own directory. Inputs are already in it; outputs are adopted from it. */
  dir: string
  progress(progress: JobProgress): void
  output(output: JobOutput): void
}
export interface ComputeWorker extends WorkerHandle {
  capabilities(): Promise<HostCapability[]>
  setup(): Promise<SetupRequirement[]>
  install(requirementId: string, io: JobIo): Promise<void>
  /** Run one declared operation. Paths in the result are inside `io.dir` or are adopted from where the worker wrote them. */
  run(cap: string, args: Record<string, unknown>, io: JobIo): Promise<{ text?: string; files: string[] }>
}
export const TEXT_WORKER = 'text'
/** llama.cpp and MLX through the existing `LocalRunners`. `stop()` is `runners.stop()`. */
export function textWorker(options: { dataDir: string; runners: LocalRunners }): ComputeWorker & {
  models(): HostModel[]
  acquire(modelId: string, signal?: AbortSignal): Promise<RunnerLease>
}
/** One worker per enabled plugin that declares `compute` (§4). Re-read whenever the plugin list changes. */
export function pluginWorkers(plugins: Pick<Plugins, 'computeWorkers' | 'computeCall' | 'stopProcess'>): ComputeWorker[]
export class Workers {
  constructor(text: ReturnType<typeof textWorker>, plugins: () => ComputeWorker[])
  all(): ComputeWorker[]
  /** The worker that declares this capability, or undefined. Never a name comparison. */
  forCapability(cap: string): Promise<ComputeWorker | undefined>
  onChange(listener: () => void): () => void
}
```

A plugin worker's `id` is an opaque handle the `Plugins` class hands out; `workers.ts`
never reads it as a name. `stop()` for a plugin worker is the `release` hook with a 15 s
deadline, then `Plugins.stopProcess(handle)` — a lazy plugin is respawned by its next job.
A plugin that vanishes mid-job fails that job `worker-failure` and unregisters its worker.

### 1.12 `inventory.ts` — what the host says about itself

```ts
export class Inventory {
  constructor(options: { dataDir: string; name: string; appVersion: string; workers: Workers; machine?: () => Promise<Machine> })
  /** The last built inventory, building it the first time. */
  current(): Promise<HostInventory>
  /** Something changed (an install finished, a plugin came or went, a job was admitted). Rebuilds and notifies. */
  refresh(reason: 'setup' | 'prepare' | 'admission' | 'workers' | 'models'): Promise<HostInventory>
  onChange(listener: (inventory: HostInventory) => void): () => void
}
```

Hardware is probed with the existing `machine()` **only** inside `refresh` for `setup`,
`prepare` and `admission`. There is no sampling loop. `revision` rises by one per rebuild
whose content changed. `capabilities` lists only operations whose worker is installed and
enabled; `ready` is false while a `SetupRequirement` names the capability in `blocks`.

### 1.13 `setup.ts` — guided remote setup

Setup is a list and a button, both already typed: `HostInventory.setup` is the list,
`ControlCalls['setup.install']` is the button, and model downloads go through the host's
existing picker operations (`models` with `op: 'install'`).

```ts
export class Setup {
  constructor(options: { workers: Workers; scheduler: Scheduler; artifacts: Artifacts; inventory: Inventory })
  /** Everything missing, from every worker. Sizes where the worker knows them. */
  requirements(): Promise<SetupRequirement[]>
  /** Start one install as a light `setup` job named by the controller. Throws ComputeError('not-found' | 'refused'). */
  install(requirementId: string, jobId: string): JobSnapshot
}
```

- The text worker reports: no llama.cpp runtime for this machine's backend (`runtime`,
  `install`, with the download's size where the runtime's asset table states one), no MLX runtime on Apple silicon (`runtime`,
  `install`), and no model installed (`model`, `instructions`: "Choose a model for this
  computer"). Its installs call the existing `ensureRuntime` / `ensureMlxRuntime`.
- A plugin worker reports whatever its `setup` hook returns (§4). An image worker that finds
  no ComfyUI offers Alexia's own copy as a requirement with its size (the official portable
  build for NVIDIA on Windows, `plugins/media/install.js`; owner decision 2026-10-03) and gives
  instructions where there is no such build; Alexia never stops or reconfigures a ComfyUI it did
  not start, and installs node packs only into its own copy.
- **Nothing installs without `setup.install` or `models install` being called**, and both
  are reached only from a button whose label shows the size.
- The controller-side half is `Controller.call(hostId, 'setup.install', …)` and
  `Controller.call(hostId, 'models', …)`; there is no separate client module.

### 1.14 `artifacts.ts` — job-scoped files on the host

```ts
import type { Readable } from 'node:stream'
import type { ArtifactPut } from './protocol.js'
import type { ArtifactRef } from './types.js'

export const ABANDONED_INPUT_MS = 60 * 60 * 1000
export class Artifacts {
  /** `dir` is `<dataDir>/compute/jobs`. One folder per job: `inputs/`, `outputs/`, `index.json`. */
  constructor(options: { dir: string; retentionMs?: number; now?(): number })
  jobDir(jobId: string): string
  /** Store an input. Rejects ComputeError('refused') on a size or hash mismatch, and deletes what it wrote. */
  put(meta: ArtifactPut, bytes: Readable, signal?: AbortSignal): Promise<ArtifactRef>
  /** Take a file a worker made as an output of this job: moved into `outputs/`, hashed, indexed. */
  adopt(jobId: string, path: string, about?: { name?: string; mime?: string }): Promise<ArtifactRef>
  open(artifactId: string, offset?: number): { artifact: ArtifactRef; bytes: Readable }
  /** Replace every `{ "$artifact": id }` in `args` with that input's path. Host-internal: the result never leaves the host. */
  resolve(jobId: string, args: Record<string, unknown>): Record<string, unknown>
  /** Mark a job submitted, so its inputs are no longer abandoned. */
  claimed(jobId: string): void
  /** The transfer was acknowledged: delete these copies now. */
  ack(artifactIds: readonly string[]): Promise<void>
  /** Delete expired artifacts, inputs of jobs never submitted within an hour, and empty job folders. Returns how many. */
  sweep(): Promise<number>
}
```

- Ids are random (`randomUUID`), names are display names with every separator stripped, and
  no API returns a path to anything but a worker on the same host.
- `sweep()` runs at service start and after each job finishes, plus one timer armed for the
  earliest `expiresAt` while any artifact exists. No timer when the folder is empty.
- The index is the folder: `index.json` per job, rebuilt by scanning if it is missing, so a
  crash leaves nothing the next `sweep()` cannot find.

### 1.15 `transfer.ts` and `jobs.ts` — the controller's side of jobs and files

```ts
// transfer.ts
/** Send one approved file as an input of `jobId`. Hashes while streaming; no whole-file buffer. */
export function upload(controller: Controller, hostId: string, jobId: string, file: { path: string; name: string; mime: string }, signal?: AbortSignal): Promise<ArtifactRef>
/** Fetch into `toDir`, verify size and SHA-256, acknowledge, and return the local path. Resumes from a partial file by `offset`. */
export function fetchArtifact(controller: Controller, hostId: string, artifact: ArtifactRef, toDir: string, signal?: AbortSignal): Promise<string>

// jobs.ts
export const JOBS_KEY = 'compute_jobs'                              // kv, CORE: { hostId, jobId, label, createdAt }[]
export interface RunHandlers { onEvent?(event: JobEvent): void }
export class RemoteJobs {
  constructor(options: { controller: Controller; store: Pick<Store, 'kvGet' | 'kvSet'> })
  /** Submit and follow to the end. Resolves with the final snapshot, whatever its state. Never retries. */
  run(hostId: string, submit: JobSubmit, handlers?: RunHandlers, signal?: AbortSignal): Promise<JobSnapshot>
  /** After a reconnect or a restart: follow a job already submitted, from the last `seq` seen. */
  attach(hostId: string, jobId: string, handlers?: RunHandlers, signal?: AbortSignal): Promise<JobSnapshot>
  cancel(hostId: string, jobId: string): Promise<JobSnapshot>
  /** Unfinished job ids for a host: what `Hello.resume` carries. */
  outstanding(hostId: string): string[]
  queue(hostId: string): QueueSnapshot | undefined
}
```

"Approved" means the interaction computer's own permission checks already passed for that
file (a plugin's `fs.read_scoped`, a file the person attached). `upload` is called after
them and adds no check of its own; the host never asks for a file.

### 1.16 `bridge.ts` — remote provider preparation

The existing `chat()` and its SSE parser stay the only client. A remote model is reached
through a loopback HTTP listener that this module owns, which forwards each request over an
`infer` stream. **The loopback address is an implementation detail, not a claim about where
inference runs**: the row's `Model.host` says where, and nothing may infer locality from a URL.

```ts
import type { Provider } from '../provider.js'
import type { Controller } from './controller.js'
import type { ExecutionTarget, TargetStatus } from './types.js'

export const REMOTE: Provider = { id: REMOTE_PROVIDER, name: 'Paired computer', baseUrl: '', auth: 'none',
  timeoutMs: 180_000, idleMs: 180_000, trainsOnYourData: 'no' }

export interface BridgeLease {
  /** `http://127.0.0.1:<port>/<leaseToken>` — what `chat()` appends `/chat/completions` to. */
  baseUrl: string
  /** A bearer key minted for this lease. The listener refuses anything else. */
  key: string
  /** The host's own id for the model: what goes in the request body. */
  model: string
  release(): void
}
export class Bridge {
  constructor(options: { controller: Controller; maxBodyBytes?: number })
  /** Select a target: open the session, `prepare` on the host, report every phase until ready or a settled failure. */
  select(target: ExecutionTarget, signal: AbortSignal, onStatus?: (status: TargetStatus) => void): Promise<{ id: string; name: string }>
  /** The selection ended: `release` on the host. In-flight answers finish. */
  deselect(): Promise<void>
  status(): TargetStatus | undefined
  onStatus(listener: (status: TargetStatus) => void): () => void
  /** `Provider.prepare`: a lease for one request. Re-prepares on the host if the idle stop released the model. */
  prepare(target: ExecutionTarget, signal?: AbortSignal): Promise<BridgeLease>
  close(): Promise<void>
}
export function remoteProvider(bridge: Bridge): Provider
// = { ...REMOTE, prepare: (model, signal) => bridge.prepare(parseCatalogId(model), signal) }
```

The listener: `127.0.0.1`, port 0, started by the first `prepare` and closed when the last
lease is released. It accepts only `POST …/chat/completions` with the lease's bearer key and
a `content-length` no larger than `maxBodyBytes` (default 64 MiB, for image inputs). For each
request it opens `{ stream: 'infer', jobId: randomUUID(), leaseId, bodyBytes }`, pipes the
body, reads `InferHead`, writes the status and content type, and pipes the answer's bytes
back with `stream.pipeline` — no parsing, no buffering, so reasoning, tool calls, usage,
image inputs and every parameter arrive exactly as the engine wrote them. The client going
away destroys the stream, which is the cancellation. A stream that breaks mid-answer
destroys the response socket, which `chat()` already reports as `dropped`; **the bridge never
retries and never opens a second stream for the same request.**

`InferHead` refusals become HTTP statuses `chat()` already turns into a `ProviderError`:
`busy` 503 · `setup-required` 409 · `worker-failure` 502 · `incompatible-version` 426 ·
`unpaired` 401 · anything else 500, each with the failure's message as the body. `offline`
is `prepare()` rejecting, which `chat()` already reports as `unreachable`.

### 1.17 `operations.ts` — a plugin's compute, sent where the person chose

The interaction-side half of §4: a plugin asks core to run one of its declared operations,
and core runs it on the selected host. Core never learns which plugin is which.

```ts
export class Operations {
  constructor(options: { store: Pick<Store, 'kvGet' | 'kvSet'>; jobs: RemoteJobs; controller: Controller;
    local: (cap: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<CallToolResult> })
  /** Runs `cap` on `selectedHost()`. Inputs are uploaded first; outputs are fetched into `toDir` and returned as paths. */
  run(request: { cap: string; args: Record<string, unknown>; inputs: { name: string; path: string; mime: string }[]; toDir: string },
      io: { signal?: AbortSignal; onProgress?(progress: JobProgress): void }): Promise<{ text?: string; files: string[] }>
}
```

When the selected host is `this`, `run` calls `local` — the same plugin's operation tool on
this computer — so a plugin written against `compute.run` behaves identically with no host
paired. When the selected host does not offer the capability, `run` rejects with
`ComputeError('setup-required')`; it does not fall back to this computer.

### 1.18 `api.ts` and `interaction.ts` — the HTTP routes and the one seam into `serve.ts`

```ts
// api.ts — the routes of §6, shared by both roles
export interface ComputeApiDeps {
  role: Role
  hosts: Hosts
  connect?: Connect                      // undefined when the sidecar binary is absent
  controller?: Controller                // interaction role
  bridge?: Bridge                        // interaction role
  jobs?: RemoteJobs                      // interaction role
  scheduler?: Scheduler                  // compute role
  protocol?: HostProtocol                // compute role
  roles: RoleSwitcher
  store: Pick<Store, 'kvGet' | 'kvSet'>
  name(): string
  appVersion: string
}
export class ComputeApi {
  constructor(deps: ComputeApiDeps)
  /** True when the path was `/api/compute/…` and has been answered. */
  handle(request: IncomingMessage, response: ServerResponse, url: URL, sent: Record<string, unknown>): Promise<boolean>
  /** What `/api/state` carries under `compute`. */
  state(): ComputeState
  /** `/api/local-models…` for a paired host: forwarded as a `models` call. */
  models(hostId: string, op: HostModelOp, args: Record<string, unknown>): Promise<unknown>
}
export interface ComputeState { role: Role; switching?: RoleSwitch; available: boolean; target?: TargetStatus; pairing?: PairingStatus; hosts: HostView[] }

// interaction.ts — everything serve.ts needs, behind one constructor
export interface InteractionCompute {
  api: ComputeApi
  provider: Provider                     // remoteProvider(bridge)
  models(): Model[]                      // remoteModels(controller.views(), selectedHost(store))
  remote: Pick<Bridge, 'select' | 'deselect' | 'status'>
  operations: Operations
  active(): number
  close(): Promise<void>
}
export function interactionCompute(options: { store: Store; dataDir: string; plugins: Plugins; busy(): boolean;
  stop(): Promise<void>; connect?: Connect; shell?: Shell }): Promise<InteractionCompute>
```

`interactionCompute` never throws for a missing sidecar: `available` is false, `hosts` is
empty, pairing answers `setup-required`, and everything else in Alexia behaves as it does
today. That is what keeps *core boots with nothing extra installed* true.

---

## 2. Seams in existing files

Each row is the whole of the change. If an implementation needs more than this in one of
these files, the design is wrong and the coordinator should hear about it first.

### `packages/core/src/provider.ts`

- `Provider.prepare`'s resolved object gains one optional field:
  `{ baseUrl: string; key?: string; model?: string; release?: () => void }`.
- In `chat()`, the request body's `model: request.model` becomes
  `model: (typeof prepared === 'string' ? undefined : prepared.model) ?? request.model`.

Nothing else. The SSE parser, patience, usage and error mapping are reused untouched.

### `packages/core/src/catalog.ts`

- `Model` gains `host?: string` — the paired host's id; absent means this computer or a
  hosted provider. Documented as the execution location, so no code has to read a URL.

### `packages/core/src/router.ts`

- `route()`: the `here` list keeps a remote row only where the placement is local:
  `world.local.flatMap(...)` adds `if (model.host !== undefined && where !== 'local') return []`.
  Cloud and Combined keep "the APIs, then **this machine**" exactly as written; a paired
  host is reached only when Local is chosen and it is the selected target.
- `send()`: the redaction line keeps its `tier === 'T0'` test. A paired host's rows are
  `T0`: hardware the person owns, chosen by them, over an end-to-end encrypted transport.
  **This is a decision for the owner to confirm** (§11); the alternative is the same line
  reading `tier === 'T0' && model.host === undefined`.
- `refusal()`: where it says *no model is installed on this Mac*, a selected remote target
  says the target's own state instead. One branch reading `world.target?: TargetStatus`,
  a new optional field on `World`.

`World.local` keeps its name and gains remote rows through `serve.ts`; `World.runners`
gains the one `REMOTE` provider. No ranking or pool code changes: a strict target is
already a pinned plan of one model (D155), so a failure stops and says so.

### `packages/core/src/modeTransition.ts`

- `ModeTransition` gains `target?: ExecutionTarget` and `targetStatus?: TargetStatus`.
  `phase` is unchanged; the connection, setup and loading detail is `targetStatus.phase`.
- `ModeTransitionOptions` gains
  `remote?: { select(target, signal, onStatus): Promise<{ id: string; name: string }>; deselect(): Promise<void> }`.
- `perform()`, after `wanted` is computed: `const target = parseCatalogId(wanted)`. When
  `target.hostId !== THIS_HOST` it takes a branch shaped like the existing `external` one:
  `runners.stop()` → `remote.select(target, signal, status => { transition.targetStatus = status; transition.message = status.message })`
  → `rememberTarget` → `setPin(store, { model: qualify(target), order: undefined })` → mode
  `local` → `ready` with `Local · <model> · <host>`. On rejection: `failed`, `picker: true`,
  the failure's message. **It never continues into the local candidate search.**
- Leaving a remote target (another mode, or a target on this computer) calls
  `remote.deselect()` where `runners.stop()` is called today.
- The constructor's one-time `last_local_model` backfill calls `selectedTarget(store)`
  instead, which performs the migration.

### `packages/core/src/commands.ts`

- `rememberLocalChoice(store, model)` becomes `rememberTarget(store, parseCatalogId(model))`.
- `setPin`'s test `/^(llama|mlx)\//` gains `|| isRemoteId(change.model)`.

### `packages/core/src/store.ts`

**No change.** Everything remote compute persists is a kv value in the `CORE` namespace
(§5), and no migration is added. Paired hosts are a handful of rows read whole; a table
would be a migration that buys nothing.

### `packages/core/src/settings.ts`

**No change.** The role is not a plugin setting and is not drawn by the widget renderer:
it has its own route (`/api/compute/role`) and its own small block on the General page
(`packages/ui/src/compute.ts`). Adding a core widget type for one switch would grow the
contract every plugin author reads.

### `packages/core/src/plugins.ts`

- `tools()` skips any tool whose `_meta['alexia/compute']` is set, so lifecycle hooks and
  worker operations are never offered to the model.
- Three small methods, none of which names a plugin:
  - `computeWorkers(): { handle: string; operations: ComputeOperation[]; hooks: ComputeHook[] }[]`
    — enabled plugins whose manifest has `compute`. `handle` is opaque to the caller.
  - `computeCall(handle, role: 'run' | ComputeHook, args, options?: CallToolRequestOptions): Promise<CallToolResult>`
    — finds the tool whose `_meta['alexia/compute']` matches and calls it.
  - `stopProcess(handle): Promise<void>` — `entry.process.stop()`.
- The `alexia/compute/run` method is answered here, by delegating to an injected
  `PluginsOptions.compute?(pluginId, params, signal, onProgress)`; absent, it answers
  `CAPABILITY_NOT_AVAILABLE`.

### `packages/core/src/serve.ts`

Eight touch points, all through `interactionCompute`:

1. After `localRunners` and `plugins` exist:
   `const compute = await interactionCompute({ store, dataDir: root, plugins, busy: operating, stop, shell })`.
2. `world()`: `local` gains `...compute.models()`; `runners` gains `compute.provider`;
   `target: compute.remote.status()`.
3. The `providers` list handed to the agent loop (`[...providers, ...localRunners.providers()]`)
   gains `compute.provider`.
4. `new ModeTransitions({ …, remote: compute.remote })`.
5. `PluginsOptions.compute` is `(pluginId, params, signal, onProgress) => compute.operations.run(…)`,
   with `toDir` the calling plugin's own directory.
6. In the request handler, before the `/api/local-models` block:
   `if (await compute.api.handle(request, response, url, sent)) return`.
   Inside the `/api/local-models` block: when `host` (query or body) is a paired host id,
   the operation is answered by `compute.api.models(host, op, args)` instead of `localModels`.
7. `/api/state` gains `compute: compute.api.state()`.
8. `close()` gains `await compute.close()` before `localRunners.stop()`; `operating()` gains
   `|| compute.active() > 0`.

`if (import.meta.main)` at the bottom moves to `entry.ts`.

### `packages/core/src/guard.ts`

One `ROUTES` entry per route in §6, with the verdict listed there. `guard.test.ts` walks the
real routes, so a route added without one fails the suite.

### `packages/protocol/src/manifest.ts`, `capabilities.ts`, `methods.ts`

See §4. In short: one optional `compute` object on the manifest, `ALEXIA_PROTOCOL_MAX` 12 → 13,
one `_meta` key (`COMPUTE_META`), one method (`alexia/compute/run`).

### `packages/sdk/src/plugin.ts`

See §4: `computeOperation()`, `computeHooks()`, `compute.run()`.

### `packages/ui`

| File | Change |
|---|---|
| `src/compute.ts` (new) | Types mirrored from `types.ts` (the UI imports nothing from core). `mountHostPicker(root, request)`: *This computer*, each paired host with `Direct`/`Relayed`/`Offline` and its failure, *Pair another computer*. `mountPairing(root, request)`: code entry or code display, countdown, cancel. `mountRole(root, request)`: the role switch with its waiting state. `mountQueue(root, request)`: running job, FIFO list, cancel. |
| `src/local-models.ts` | The view takes a `host` and passes it on every `LocalRequest`; the header is the host picker. Fit, downloads and progress then describe the selected host because the answers come from it. Import-from-file and the token field are hidden for a paired host. |
| `src/mode-transition.ts` | `ModeTransition` gains `target` and `targetStatus`; the line under the switch shows the host, the model and the phase, and offers the picker on a settled failure. |
| `src/settings.ts` | The General page mounts `mountRole`; the Models page mounts the host picker above the local models view. |
| `src/rail.ts` | The model line shows the host's name and connection state beside a remote model. |
| `src/main.ts` | Reads `state.compute`; passes it to the three views above. |
| `compute.html` + `src/compute-setup.ts` (new) | The compute role's only page: pairing code, paired controller, setup list with sizes, the host's own model picker, role switch, *Close window*. Served by `service.ts`. |
| `app.css` | Styles for the above. |

### `src-tauri/src/main.rs`

See §8.

### `scripts/package.mjs`, `scripts/sidecar.mjs`, `src-tauri/tauri.conf.json`

- `package.mjs`: the esbuild entry becomes `packages/core/dist/src/entry.js`; the generated
  `boot.mjs` calls `start({ port, secrets })` instead of `serve(...)`.
- `sidecar.mjs`: copies the built `alexia-connect` to
  `src-tauri/binaries/alexia-connect-<triple>` (and `lipo`s it for a universal build), the
  way it already does for `alexia-core`.
- `tauri.conf.json`: `externalBin` gains `binaries/alexia-connect`. No capability change:
  core spawns it with `node:child_process`, not through the shell plugin.

`tauri.dev.conf.json` and `scripts/dev-app.mjs` are not referenced by any of this.

---

## 3. The compute protocol

Defined in `protocol.ts`. This section says what the types cannot.

**Framing.** Every stream begins with one `StreamOpen` frame. A frame is one JSON value and
a newline (`encodeFrame` / `splitFrame`), at most 1 MiB. `control` and `job` streams are
frames throughout. `infer` and `artifact` streams carry raw bytes after a frame that states
their length or precedes them: an answer or a file is never wrapped in JSON.

**Versioning.** `Hello.protocol` is the range the controller speaks; the host answers with
the single version `negotiate` picks, or refuses `incompatible-version`. A new optional
field does not move the version. A changed meaning or a new required message does, and
`COMPUTE_PROTOCOL_MIN` moves only when an old version is dropped on purpose.

**Control.** After `welcome`, the controller sends `ControlRequest`s with ids it chooses
(rising integers); each gets exactly one `ControlResponse`. The host sends `ControlEvent`s
whenever inventory, queue, a job or a lease changes — never on a timer. `ping` exists for
the controller to measure the path; the host never pings.

| Method | Params | Result | Notes |
|---|---|---|---|
| `inventory.get` | — | `HostInventory` | Also pushed as `inventory` when it changes. |
| `queue.get` | — | `QueueSnapshot` | Also pushed as `queue`. |
| `prepare` | `leaseId`, `modelId` | `Lease` | Answers at once with `queued`/`loading`; `lease` events follow until `ready` or a failure. One lease per controller: a new `prepare` releases the old. |
| `release` | `leaseId` | — | Starts the idle clock. Unknown lease is not an error. |
| `job.status` | `jobId` | `JobSnapshot` | `not-found` for an id the host never saw. |
| `job.cancel` | `jobId` | `JobSnapshot` | Idempotent. |
| `setup.install` | `jobId`, `requirementId` | `JobSnapshot` | A light `setup` job; progress as `job` events. |
| `models` | `op`, `args` | the picker's own JSON | `op` ∈ `HOST_MODEL_OPS`. `import`, `import-preview` and `token` are not offered. |
| `artifact.ack` | `artifactIds` | — | Host deletes its copies. |
| `ping` | — | — | |

**Lease lifecycle.** `queued` → `loading` → `ready` → `released`. A lease is released by
`release`, by the idle stop, by a `prepare` for another model, by revocation, and when the
reconnect grace runs out. An `infer` stream naming a released lease whose model is still
installed re-prepares it in place (queue, load, then answer): this is "reacquire the model
if its idle timeout has elapsed", and it is the same model on the same host or a refusal.

**What is deliberately absent.** No message runs a named plugin, calls a tool by name,
reads a host path, lists a host directory, or returns a secret. Adding one is a protocol
change and a new decision.

---

## 4. The plugin compute-worker contract

A plugin that can do heavy work says so in its manifest, marks the tools that do it, and
core does the rest by capability. **`alexia_protocol` 13.** Additive: a manifest without
`compute` means what it meant at 12, and the floor stays at 2.

### 4.1 Manifest

```jsonc
{
  "provides": ["image.generate", "image.render"],
  "compute": {
    "operations": [
      { "cap": "image.render", "summary": "Render an image from a prepared workflow", "weight": "heavy" }
    ],
    "hooks": ["setup", "install", "release"]
  }
}
```

```ts
// packages/protocol/src/manifest.ts, inside ManifestShape
compute: z.object({
  operations: z.array(z.object({
    cap: z.string().regex(CAPABILITY),
    summary: z.string().min(1).max(120),
    weight: z.enum(['heavy', 'light']).optional(),      // absent means heavy
  }).strict()).min(1),
  hooks: z.array(z.enum(['setup', 'install', 'prepare', 'release'])).optional(),
}).strict().optional(),

export type ComputeOperation = NonNullable<Manifest['compute']>['operations'][number]
export type ComputeHook = NonNullable<NonNullable<Manifest['compute']>['hooks']>[number]
```

`superRefine` adds: every `operations[].cap` must also be in `provides`, and no two
operations may share a `cap`. `versionVerdict` needs nothing new.

The convention this enables: a plugin keeps its person-facing capability (`image.generate`:
planning the prompt, asking permission, reading the person's files) and adds a second,
narrower one for the heavy half (`image.render`). The first runs on the interaction
computer; only the second is a compute operation.

### 4.2 The `_meta` binding and the method

```ts
// packages/protocol/src/capabilities.ts
/** On a tool: this tool is a compute operation (`{ op: '<cap>' }`) or a lifecycle hook (`{ hook: '<name>' }`). */
export const COMPUTE_META = 'alexia/compute'

// packages/protocol/src/methods.ts — plugin → core
'alexia/compute/run': {
  params: z.object({
    cap: z.string().min(1),
    arguments: z.record(z.string(), z.json()).optional(),
    /** Files to send with the job. Each `path` must be one the plugin may already read. */
    inputs: z.array(z.object({ name: z.string().min(1), path: z.string().min(1), mime: z.string().min(1) })).optional(),
  }),
  result: z.object({
    text: z.string().optional(),
    /** Absolute paths in the caller's own directory, already verified. */
    files: z.array(z.string()),
  }),
}
```

Core refuses `alexia/compute/run` for a `cap` that is not one of the caller's own
`compute.operations` or in its `requires[]`. Progress travels on the request's progress
token, the way `alexia/stream` already does.

Why a method rather than `alexia/capability/call`: that call answers from *this* computer
and carries no files. This one says "wherever the person chose", moves the inputs and
brings the outputs home. The seventh-family bar in `wire-protocol.md` is met the same way
`alexia/answers` met it: MCP has no notion of where a tool runs.

### 4.3 SDK

```ts
// packages/sdk/src/plugin.ts, on AlexiaPlugin
/**
 * Register the tool that performs one of your declared `compute.operations`. Never shown to
 * the model. `args` arrive with every staged input replaced by a path you can read; return
 * the files you made and Alexia carries them back.
 */
computeOperation(cap: string, handler: (args: Record<string, unknown>, ctx: ServerContext) =>
  Promise<{ text?: string; files?: string[] }>): void

/** The lifecycle hooks you listed in `compute.hooks`. Every one is optional. */
computeHooks(hooks: {
  /** What is missing before your operations can run here, with sizes. Called on setup and after an install. */
  setup?(): Promise<ComputeRequirement[]>
  /** Install one requirement you returned. Report progress on `ctx`. Called only after the person pressed its button. */
  install?(requirementId: string, ctx: ServerContext): Promise<void>
  /** Get ready for an operation that is about to run: load the model, start your worker process. */
  prepare?(cap: string): Promise<void>
  /** Let go of model memory and stop processes you started. Called before another backend loads and at the idle stop. */
  release?(): Promise<void>
}): void

readonly compute: {
  /** Run one of your operations where the person chose: this computer or their paired host. */
  run(cap: string, args?: Args, options?: { inputs?: { name: string; path: string; mime: string }[]; onProgress?(progress: number, total?: number, message?: string): void; signal?: AbortSignal }):
    Promise<{ text?: string; files: string[] }>
}

export interface ComputeRequirement {
  id: string; kind: 'runtime' | 'model' | 'dependency'; title: string; detail?: string
  bytes?: number; action: 'install' | 'instructions'; instructions?: string; blocks: string[]
}
```

Under the hood `computeOperation` and `computeHooks` register ordinary MCP tools with
reserved names (`alexia_compute_<cap>` and `alexia_compute_<hook>`) and
`_meta: { 'alexia/compute': … }`. Cancellation is MCP's own; progress is `alexia.progress`.

### 4.4 Lifecycle, as core runs it on a host

```text
discover   Plugins.computeWorkers()            manifests of enabled plugins — spawns nothing
setup      hook 'setup'   → SetupRequirement[] on inventory refresh for setup, and after an install
install    hook 'install' (requirementId)      only from ControlCalls['setup.install']
admit      Scheduler.submit → turn             other loaded workers stopped first
prepare    hook 'prepare' (cap)                if declared
run        the tool bound to { op: cap }       args resolved by Artifacts.resolve; progress → JobEvent
adopt      result.files → Artifacts.adopt      paths never leave the host
idle       IDLE_STOP_MS after the last job     hook 'release', 15 s, then the process is stopped
```

### 4.5 What keeps the invariants true

- Core finds workers by reading `manifest.compute`, and calls them by `cap` and `_meta`.
  No file under `packages/core/src` contains a plugin id; invariant 1's grep and the
  dependency rule both still pass with no exemption.
- Delete a compute plugin's folder on a host: `Plugins` drops the entry, `Workers.onChange`
  fires, `Inventory.refresh('workers')` removes its capabilities, and the controller is
  sent a new `inventory`. A job of its that was running fails `worker-failure`. Chat
  inference and the service itself are untouched (plan §13, *plugin removal*).
- Delete it on the interaction computer: its person-facing tool goes, as today. The host's
  copy still lists the capability, and nothing asks for it.
- `Plugins` on a host is constructed with no `sample`: a compute worker cannot ask for a
  model, cannot start a task and has no roots. It is a function with files in and files out.
- A worker runs only what its own manifest declared. There is no "call tool X on the host".

---

## 5. Persistence

Everything is kv in the `CORE` namespace of `alexia.db`, plus one folder. No table, no
migration, and the same database in both roles — which is why switching roles keeps chats.

| Key | Value | Written by | Role |
|---|---|---|---|
| `compute_role` | `'interaction' \| 'compute'`; absent is `interaction` | `RoleSwitcher` | both |
| `compute_hosts` | `PairedHost[]` | `Hosts` | both (the compute role holds at most one, its controller) |
| `local_target` | `ExecutionTarget` | `rememberTarget` | interaction |
| `last_local_model` | catalog id (existing) | `rememberTarget`, only for `hostId: 'this'` | interaction |
| `compute_jobs` | `{ hostId, jobId, label, createdAt }[]`, unfinished only | `RemoteJobs` | interaction |
| `compute_services` | `{ relay?: string; mailbox?: string }`; absent is the built-in defaults | `/api/compute/services` | both |
| `compute_window` | `true` while the compute role should keep its window for one launch | `service.ts` | compute |
| `compute_paused` | `boolean` | `HostProtocol.pause` | compute |

On disk, compute role only: `<dataDir>/compute/jobs/<jobId>/{inputs,outputs,index.json}`.

Secrets: none of the above. Endpoint private keys are the sidecar's, in the OS keychain,
under an entry of its own; TypeScript has no operation that reads them and neither does a
plugin.

### Migration of saved selections to `hostId: 'this'`

There are three places a model selection is saved. None needs rewriting, by construction:

1. **`pins.model` and `pins.order`** hold catalog ids. An id with no `@<host>/` prefix *is*
   an id on this computer (`parseCatalogId`), so every stored pin already reads as
   `{ hostId: 'this', modelId }`. Nothing is written.
2. **`last_local_model`** is a bare id. The first `selectedTarget(store)` after the update
   finds no `local_target`, reads `last_local_model` (or, failing that, `pins.model` when the
   mode is `local`), runs it through `migrateSelection`, and writes
   `local_target = { hostId: 'this', modelId }`. `last_local_model` is left in place and
   kept in step, so a downgrade still finds what it expects.
3. **Anything else that stores or shows a model id** (the usage ledger, the trace, a
   plugin's `/status`) is given the catalog id unchanged, so old rows keep meaning what they
   meant and new remote rows are told apart by their prefix.

`migrateSelection` is unit-tested in `compute-types.test.ts`; the store-level migration is
T2's acceptance (§9).

Unpairing a host whose model is the saved target clears `local_target` and the pin, leaves
the mode as it is, and the next Local switch opens the picker. It does not pick another
model.

---

## 6. HTTP routes the screen calls

All under `/api/compute`, all through `ComputeApi.handle`, all behind the existing token and
`Host` check, and all after `guard.ts`'s `refuse()` — the confirm is asked for there, before a
route sees the request, so whatever serves these routes must run the guard first (`serve.ts`
does; `service.ts` must). Every body and answer is JSON. Errors are `{ ok: false, said, code? }`
with `code` a `ComputeErrorCode`. "Roles" says where the route answers; in the other role it is
`409` with `code: 'refused'`.

**This section describes what `compute/api.ts` serves**, and is checked by
`packages/core/test/compute-api.test.ts`: two Alexias in one process, joined by `memoryConnect()`.

| Method · path | Body / query | Answer | Guard | Roles |
|---|---|---|---|---|
| `GET /api/compute/role` | — | `{ role, switching?: RoleSwitch, active: number }` | read | both |
| `POST /api/compute/role` | `{ role, cancel?: boolean, confirm: true }` | `{ ok, note }` — sent again with `cancel: true` for the same role while the switch is `waiting`, it stops waiting and cancels the work instead | confirm: *switch this computer's role; running work is finished or cancelled first* | both |
| `POST /api/compute/role/cancel` | — | `{ ok, note }` — gives up a switch that is still `waiting`; `409` once it has begun stopping services | safe: *nothing has been stopped yet, so the computer keeps its role* | both |
| `GET /api/compute/hosts` | — | `{ hosts: HostView[], selected: string, available: boolean }` | read | both |
| `POST /api/compute/pair/start` | interaction: `{ code }` · compute: `{}` | `{ ok, pairing: PairingStatus }` | safe: *pairing only records a public identity and is undone by Unpair* | both |
| `GET /api/compute/pair` | — | `{ pairing?: PairingStatus }` | read | both |
| `POST /api/compute/pair/cancel` | — | `{ ok }` | safe | both |
| `POST /api/compute/unpair` | `{ host, confirm: true }` | `{ ok }` | confirm: *forget this computer; its running jobs are cancelled* | both |
| `GET /api/compute/inventory` | interaction: `?host=` · compute: nothing | `{ inventory?: HostInventory, connection, failure? }` — on a compute host it is that computer's own inventory, setup list included | read | both |
| `GET /api/compute/status` | interaction: `?host=` (default: the selected target's host) · compute: nothing | `{ connection: ConnectionState, label: 'Direct' \| 'Relayed' \| 'Offline', failure?, target?: TargetStatus }` | read | both |
| `POST /api/compute/select` | `{ host }` — a paired host's id, or `'this'` | `{ ok }` — sets the host shown in the picker; choosing a model is still `/api/local-models/use` | safe | interaction |
| `POST /api/compute/setup/install` | interaction: `{ host, requirement }` · compute: `{ requirement }` | `{ ok, job: JobSnapshot }` | safe: *the size was shown on the button; Remove undoes it* | both (compute: on itself) |
| `GET /api/compute/queue` | interaction: `?host=` · compute: nothing | `{ queue: QueueSnapshot }` | read | both (compute: its own) |
| `GET /api/compute/job` | `?job=`, and `?host=` on the interaction computer | `{ job: JobSnapshot }` — one job by id, whatever its state; `404 not-found` for an id nobody knows | read | both (compute: its own) |
| `GET /api/compute/jobs` | interaction: `?host=` · compute: nothing | `{ jobs: JobSnapshot[] }` — newest first, finished and interrupted jobs included | read | both (compute: its own) |
| `POST /api/compute/jobs/cancel` | `{ host, job }` — on a compute host `host` is `'this'` or absent | `{ ok, job: JobSnapshot }` | safe | both (compute: its own queue) |
| `POST /api/compute/pause` | `{ paused }` | `{ ok }` | safe | compute |
| `GET /api/compute/services` · `POST` | `{ relay?, mailbox? }` — absent or empty clears one | `{ relay?, mailbox?, defaults: boolean }` | read · safe (takes effect when the sidecar next starts) | both |
| `POST /api/compute/window/close` | — | `{ ok }` — the compute role's window may go | safe | compute |

Status codes: `404` for a host id that is not paired (`code: 'unpaired'`) and for a job or
requirement nobody knows (`not-found`); `400` for a body that is missing something; `503` for
`offline` and `busy`; `502` for `worker-failure`; `409` for every other refusal. The code in
the body is what the screen reads; the status only says that it is a refusal.

**What each read costs.** `hosts` opens a control session to every paired host that has none,
and does not wait for it: the answer is what is known now, and the next poll has the inventory.
`inventory` waits up to 1.5 s for that session and then answers with the view, failure
included. `queue`, `job`, `setup/install` and `jobs/cancel` need the host, wait up to 12 s for
it, and answer `503 offline` when it does not come. On a compute host `inventory` is the last
one built — a page that polls it probes no hardware and asks no worker anything.

**One job, and the jobs that have left the queue.** `job` asks the host by id, so a setup
install's progress and failure, and a job that finished, failed or was interrupted, are all
readable for as long as the host remembers them (24 h, §1.10 rule 6). `jobs` is what this run
of Alexia heard a host say about its jobs — the last 50, kept in memory, answers that
succeeded left out — and it is how a job that was interrupted while nobody was looking is
still shown. A job the host no longer knows, that was last heard running, is reported
`interrupted`.

**Nothing a host wrote is shown as it wrote it.** Every failure message and progress line in
these answers, and in `modeTransition.targetStatus`, has anything shaped like a filesystem
path replaced (`scrub` in `api.ts`).

**Remote download and fit** are not new routes. The existing `/api/local-models…` family
takes `host` — in the query on a `GET` and on `DELETE /api/local-models/<id>`, in the body on a
`POST`, and read from either place on any of them. Absent or `this` is today's behaviour; a
paired host id is answered by `ComputeApi.handle`, which forwards the operation with
`ComputeApi.models`. So `GET /api/local-models?host=<id>` is the host's overview with **its**
machine and **its** fit verdicts, `POST /api/local-models/install { host, … }` downloads
**onto the host**, and `GET /api/local-models/progress?host=<id>&job=…` follows it. A `mode`
sent with a remote install is dropped: a download onto a host changes nothing about this
computer's mode, and choosing the model afterwards is `use`. `import`, `import-preview`,
`maintenance` and `token` answer `400` for a paired host. A refusal from the host keeps the
host's own sentence, with `code: 'refused'` (or `not-found` for a job that is gone).
`POST /api/local-models/use { id: '@<host>/<model>' }` is the selection, through
`ModeTransitions` as today; it is never forwarded, and it answers `409` for `mode: 'combined'`
because a paired host is reached only in Local.

**On a compute host** the same family is that computer's own picker, served by `ComputeApi`
from `ComputeApiDeps.models` (`localPicker(localModels)`): every route `serve.ts` has except
`use`, which answers `409` — a compute host chooses no model for itself. `token` is stored
through `ComputeApiDeps.token`. The other end of the forwarded operations is
`hostModels(localModels)`, which is what `HostProtocolOptions.models` is given; the argument
names are the HTTP routes' own, and both adapters are in `api.ts` so they cannot drift.

`/api/state` gains `compute: ComputeState`, and `modeTransition` gains `target` and
`targetStatus`, so the screen needs no extra poll to draw the switch. `ComputeState.pairing`
never carries the code: only `GET /api/compute/pair` and the answer to `pair/start` do, on the
computer that opened the pairing, and only until the pairing settles.

`selected` in `hosts` is the host the picker is showing (`compute_shown_host`, set by
`select`), falling back to the selected target's host. It is not the target: looking at a
host chooses nothing. Unpairing the shown host puts it back to `this`.

`available` is whether pairing can be offered: a sidecar is installed, running or not. With
nothing paired the sidecar is not started at launch; the first `pair/start` starts it. With no
binary, or one that would not start, `available` is false and `pair/start` answers
`409 setup-required`.

Pairing, as the screen sees it: the compute host presses *Pair* and shows
`PairingStatus.code` with a countdown to `expiresAt`; the interaction computer types it.
Both poll `GET /api/compute/pair` (1 s, only while a pairing is open). Phases:
`waiting` → `connecting` → `verifying` → `paired`, or `failed` / `expired` / `cancelled`,
each of which needs a fresh code. A compute host that is already paired refuses
`pair/start` with *Unpair the current computer first*. Two computers in the same role end
`failed`. `paired` is said only after core has written the record, told the sidecar to allow
the endpoint, and kept its address hints (`compute_hints`).

Unpairing, from the interaction computer: every job of that host this computer knows is
cancelled while the host can still be told. If the host advertises `Welcome.controllerUnpair`,
the controller sends the optional `bye unpaired` message before dropping the session; the
host handles it with `HostProtocol.revoke()`, cancelling every job, forgetting its controller
and replacing its allowlist to close the connections. The interaction computer then forgets
the record, the hints and the unfinished `compute_jobs` rows, and replaces its own allowlist.
An unreachable host, or one that does not advertise the optional message, keeps its
controller record and accepts no other until somebody unpairs at the host. Unpairing from
the compute host calls `HostProtocol.revoke()` directly and sends `bye unpaired` if the
controller is still reachable; the interaction computer keeps its record but stops
reconnecting and reports the host as unpaired.

The page: `serve.ts` serves `/compute.html` and its module `/compute-setup.js` beside the
shell's other files.

Keys this section adds to §5's table, all kv in `CORE`: `compute_shown_host` (a host id or
`'this'`, interaction) and `compute_hints` (`{ [hostId]: ConnectHints }`, interaction).

---

## 7. What TypeScript needs from the native sidecar

Requirements only. **The concrete loopback API is the sidecar author's and is documented in
[`connect/README.md`](../../connect/README.md); `compute/connect.ts` is written against that
file and nothing here specifies a wire format.**

Launch and authentication

1. Starts as a child of core, takes a per-launch secret core hands it at spawn (not in argv,
   not in the environment), and serves its control API on loopback only. Every request must
   present that secret; anything without it is refused before it is parsed.
2. Says when it is ready, and on which loopback address, through a channel only core reads.
3. Exits when core's end of that channel closes, and on an explicit shutdown request.
4. Takes its configuration at launch: role, relay and mailbox addresses (or "use the
   defaults"), a data-name so *Alexia Dev* and Alexia never share an identity, and the
   initial allowlist.

Identity and trust

5. Creates and keeps the endpoint private key in the OS keychain, under an entry of its
   own. **No API returns the private key or lets it be exported.** It reports the public
   endpoint identity as an opaque string.
6. Holds an allowlist of peer identities that core can replace at any time. Traffic from an
   endpoint not on it is rejected in the sidecar, before core sees a byte. Removing an
   endpoint closes its connections at once and reports that it did.
7. LAN discovery is used only to find an address for an allowed identity, never to allow one.

Pairing

8. *Open* a pairing: returns a single-use code (a mailbox number and four words), valid five
   minutes, one attempt. *Join* a pairing by code. *Cancel* either.
9. Carries one small opaque payload from core in each direction inside the authenticated
   pairing channel (≤ 1 KiB: display name, role, platform, version). The sidecar does not
   interpret it.
10. Reports success **only after** both sides have proved possession of the exchanged
    endpoint identities over iroh. Reports failure with a reason core can map to
    `expired`, `cancelled` or `refused`. A code is dead after success, failure, cancel or
    expiry.
11. Never logs a code or pairing message. Core will not either.

Streams

12. *Open* a bidirectional stream to an allowed peer for one of four kinds — `control`,
    `infer`, `job`, `artifact` — and deliver the peer's streams to core labelled with the
    kind and the **authenticated** peer identity. Any other kind is refused in the sidecar.
13. Each stream is its own QUIC stream: a stalled artifact transfer must not delay a
    `control` frame or an answer's tokens.
14. Bytes are forwarded unmodified and unbuffered beyond a bounded window, with backpressure
    in both directions: core not reading slows the peer's writer, and the reverse.
15. A stream ends three distinguishable ways: finished cleanly, reset by the peer, lost with
    the connection. Core can reset a stream itself (this is cancellation).
16. On the host, streams reach core's compute service over authenticated loopback; nothing
    but the sidecar can present a stream to that service.

Connection state

17. Per allowed peer, reports `direct`, `relayed` or `offline`, and **pushes** every change.
    Core does not poll.
18. Prefers a direct path, falls back to an encrypted relay, and keeps trying to upgrade.
    Reconnects on its own after sleep or a network change, within core's 15 s grace when the
    network allows.
19. Two already-paired computers on one LAN connect with no internet.

Not the sidecar's: job ids, queues, leases, inventory, setup, permissions, artifacts'
meaning, the role, the host records, anything a person reads.

---

## 8. Rust budget

Invariant 10 counts hand-written, non-blank, non-comment lines in `src-tauri/src/**/*.rs`.
Today that is **592** (`main.rs` 362, `glass.rs` 85, `vault.rs` 75, `snapshot.rs` 46,
`temps.rs` 24) against a budget of **595**.

**The sidecar costs nothing against it.** It is a separate crate at repo-root `connect/`,
outside the glob, spawned by core rather than by the shell. The invariant test needs no
change to exclude it, and must not gain a `connect/` entry: its own tests are its own gate.
`src-tauri` gains no dependency on it and no code that speaks to it.

**`main.rs` must gain compute mode**, because only the process that owns the windows, the
hotkeys and the tray can remove them:

| Addition | What it does | Lines (est.) |
|---|---|---|
| Read core's stdout in the existing event loop | `CommandEvent::Stdout` → match three `@shell` prefixes | 14 |
| `fn compute_mode(app, status)` | destroy `main`, `overlay`, `control`; `unregister_all()` hotkeys; leave the Dock; swap the tray menu | 24 |
| Compute tray menu | status line (disabled), *Pause/Resume*, *Unpair*, *Switch role*, *Open window*, *Quit* | (in the 24) |
| Tray events → core | four ids write `tray <action>\n` to the held `CommandChild` | 11 |
| Status and relaunch | `@shell status` sets the tooltip and the status item; `@shell relaunch` calls the existing restart | 8 |
| **Total** | | **≈ 55–65** |

So the budget moves **595 → 660**, with the same kind of paragraph in
`10-rust-line-budget.test.ts` as the earlier raises: *it decides nothing — core says when
the windows may go and what the status line reads; a tray click is one line down a pipe.*
Pausing, unpairing, switching roles and what "idle" means are all TypeScript. If the real
cost passes 70 lines, something has leaked and should move behind `shell.ts`.

Not needed in Rust: spawning or supervising the sidecar, the updater (the page's existing
flow, reachable in compute mode through *Open window*), pairing UI, any HTTP client.

---

## 9. Work breakdown

File ownership is disjoint: no file appears in two tasks. Size is small / medium / high.
"After" lists hard dependencies; everything else codes against §1's signatures and
`memoryConnect()`. Tasks in the same wave can run in parallel.

| # | Task | Owns | After | Size | Observable acceptance |
|---|---|---|---|---|---|
| T0 | Contract (this task) | `docs/spec/remote-compute.md`, `compute/types.ts`, `compute/protocol.ts`, `test/compute-types.test.ts` | — | medium | done: typecheck, the unit test and lint pass |
| T1 | Sidecar | `connect/**` | — | high | its own tests; README documents the loopback API against §7's 19 requirements, each marked met or not |
| T2 | Role + target + hosts | `compute/role.ts`, `compute/target.ts`, `compute/hosts.ts`, tests | T0 | small | a store holding `last_local_model: 'llama/x'` yields `local_target {this, llama/x}` and leaves the pin unchanged; a second controller is refused in the compute role; a role switch waits for `active()` to reach 0 and writes the role only after `stop()` |
| T3 | Connect client | `compute/connect.ts`, test | T0; T1's README for the real client | medium | `memoryConnect()` passes a suite the real client also passes against a built sidecar: allowlist enforced, four kinds only, backpressure (a slow reader stalls the writer), reset is distinguishable from end |
| T4 | Scheduler | `compute/scheduler.ts`, test | T0 | medium | fake timers prove §1.10's six rules: one heavy at a time, FIFO order, queued cancel is immediate, other loaded workers stopped before a turn, idle stop at exactly 10 min, pause |
| T5 | Artifacts | `compute/artifacts.ts`, test | T0 | medium | a bad hash is refused and leaves no file; `sweep()` removes an expired artifact, an abandoned input and an empty job folder; no method returns a path for an unknown job; names with separators are flattened |
| T6 | Manifest + SDK | `packages/protocol/src/{manifest,capabilities,methods}.ts`, `packages/sdk/src/plugin.ts`, `docs/spec/{manifest,capabilities,wire-protocol,versions}.md`, their tests | T0 | medium | a manifest with `compute` validates at protocol 13 and is rejected when an operation's `cap` is not in `provides`; an SDK plugin's operation tool carries `COMPUTE_META` and is callable; conformance suite passes |
| T7 | Plugins seam | `packages/core/src/plugins.ts`, test | T6 | small | `tools()` omits `COMPUTE_META` tools; `computeWorkers()` lists a fixture plugin without spawning it; removing the fixture's folder removes it from the list; invariant 1 passes |
| T8 | Workers + inventory + setup | `compute/workers.ts`, `compute/inventory.ts`, `compute/setup.ts`, tests | T4, T5, T7 | high | text worker loads a model through a fake `LocalRunners`; a fixture plugin worker runs an operation with a staged input and its output is adopted; inventory lists only installed workers' capabilities; `machine()` is called only on the three named reasons |
| T9 | Host protocol | `compute/hostProtocol.ts`, test | T3, T4, T5, T8 | high | over `memoryConnect()`: version mismatch refused; an `infer` stream returns a stub runner's SSE byte-for-byte; closing it aborts the runner request; a job survives its stream closing; revoke cancels jobs and closes streams |
| T10 | Controller + jobs + transfer | `compute/controller.ts`, `compute/jobs.ts`, `compute/transfer.ts`, tests | T3 | high | against a scripted host: reconnect re-sends `Hello` with `resume` and never a submit; an offline host stays in `views()` with `offline`; a fetched artifact is verified, written, acknowledged; a job reported `interrupted` resolves `run()` with that state |
| T11 | Bridge + operations | `compute/bridge.ts`, `compute/operations.ts`, tests | T10 | medium | `chat()` through the bridge against T9's host returns text, reasoning, tool calls and usage identical to a direct call; a wrong bearer key is 401; an aborted request resets the stream; a broken stream surfaces as `dropped` with no second stream opened |
| T12 | Core seams | `provider.ts`, `catalog.ts`, `router.ts`, `modeTransition.ts`, `commands.ts`, their tests | T2, T11 | medium | a remote row is routed only in Local placement; a failed remote select ends `failed` with `picker: true` and no local model loaded; `prepare().model` reaches the request body; existing router and mode tests still pass |
| T13 | API + interaction wiring | `compute/api.ts`, `compute/interaction.ts`, `serve.ts`, `guard.ts`, tests | T2, T10, T11, T12 | high | every §6 route answers as specified over HTTP with two in-process Alexias joined by `memoryConnect()`; `/api/local-models?host=` returns the host's machine; with no sidecar binary `serve()` starts and `compute.available` is false; `guard.test.ts` passes |
| T14 | Compute service + entry | `compute/service.ts`, `compute/shell.ts`, `packages/core/src/entry.ts`, `scripts/package.mjs`, tests | T8, T9, T13 (for `api.ts`) | high | `start()` in the compute role opens no chat table, starts no catalog poll, and serves `/api/compute/*`; `close()` leaves no child process; idle for 5 simulated minutes arms no timer but the artifact expiry |
| T15 | Shell compute mode | `src-tauri/src/main.rs`, `packages/core/test/invariants/10-rust-line-budget.test.ts` | T14's `shell.ts` line format (§1.7) | small | in *Alexia Dev*: after `@shell compute`, no window exists and the hotkey does nothing; each tray item reaches core; budget test passes at 660 |
| T16 | Screen | `packages/ui/**` | T13's routes (§6) | high | pair, select a host, see its models and fit, download onto it, switch to it, see `Direct`/`Relayed`/`Offline` and each of the five failure states, cancel a queued job; invariant 6 passes |
| T17 | Worker adapters | `plugins/` (the image and voice packages) | T6, T8 | high | each declares `compute`, splits planning from the heavy operation, reports setup with sizes, releases on `release`; removing either leaves chat inference and the service working |
| T18 | Packaging | `scripts/sidecar.mjs`, `src-tauri/tauri.conf.json`, `tauri.macos.conf.json`, workflows | T1, T14 | medium | the installer contains `alexia-connect` beside `alexia-core`, signed; quitting leaves neither running |

Waves:

- **Wave 1 (parallel):** T1, T2, T3 (against `memoryConnect`), T4, T5, T6.
- **Wave 2 (parallel):** T7, T10, then T8 and T11.
- **Wave 3 (parallel):** T9, T12, T16 (against §6), T17.
- **Wave 4:** T13, then T14, T15, T18.

This matches the plan's rollout order: transport and pairing first (T1–T3), minimal compute
mode and remote LLM routing second (T4, T5, T8–T15 for the text worker), the generic worker
contract and adapters third (T6, T7, T17), guided setup and artifacts fourth (finishing T8,
T5's use by T17).

Two-machine validation (plan §12, §13) is not a task here and cannot be mocked; no number
in the plan's performance targets is claimed by any acceptance above.

---

## 10. Cancellation and recovery, in one place

| Event | What happens | Who |
|---|---|---|
| Cancel a queued job | Leaves the queue in the same tick, `cancelled`. | `Scheduler.cancel` |
| Cancel a running job | `cancelling`; the worker's `signal` aborts; `cancelled` when it stops. A plugin worker gets MCP cancellation, then its process is stopped after 15 s. | `Scheduler`, `Workers` |
| Stop pressed during an answer | `chat()`'s fetch aborts → the bridge destroys the `infer` stream → the host aborts the runner request. | `bridge.ts`, `hostProtocol.ts` |
| Control session lost | Host arms **one** 15 s timer. Running and queued jobs carry on. In-flight `infer` streams are already broken and are not resumed. | `hostProtocol.ts` |
| Reconnect within 15 s | Timer cleared. `Hello.resume` → `Welcome.jobs` gives each job's state; the controller `attach`es to the unfinished ones from its last `seq`. | `controller.ts`, `jobs.ts` |
| Grace expires | `Scheduler.cancelAll('interrupted')`, leases released, idle clocks start. Finished results stay fetchable for 24 h. | `hostProtocol.ts` |
| Reconnect after grace, or after a host restart | Jobs are reported `interrupted` (or their real final state if they finished). The screen says so. | `jobs.ts` |
| Controller restarts | `compute_jobs` names what it was waiting on; same path as a reconnect. | `jobs.ts` |
| Controller revoked / unpaired | Allowlist replaced (sidecar closes the connections), every job cancelled, record forgotten, `bye unpaired` if still reachable. | `HostProtocol.revoke` |
| Quit, role switch | `bye`, cancel all, stop every worker, stop the sidecar. | `service.ts` |

Two things never happen, anywhere:

- **Nothing is resubmitted.** A job id is submitted once by the code path that created it.
  `RemoteJobs.run` has no retry. The bridge opens one `infer` stream per HTTP request.
- **No tool call is replayed.** A broken answer reaches the agent loop as `dropped`, which
  is the existing behaviour for any provider: the loop's own rules decide, and a strict
  target means there is no other model to walk to (D155).

The states a person can be shown are exactly `ComputeErrorCode`'s first five — `offline`,
`busy`, `incompatible-version`, `setup-required`, `worker-failure` — plus `interrupted` for
a job and `unpaired` for a host that forgot this computer. Each is a code; the sentence is
the screen's, and the screen never substitutes a different target to avoid showing one.

---

## 11. Open decisions for the owner

1. **Is a paired host `T0` for redaction?** This design says yes (§2, `router.ts`): it is
   owned hardware, explicitly chosen, end-to-end encrypted, so credentials and location are
   not stripped, as for a model on this computer. The stricter reading is a one-line change.
2. **Hugging Face tokens for gated models on a host** are entered at the host (its setup
   window), not sent from the interaction computer. Sending one would be the first secret
   to cross the link.
3. **A hold is not for ever** (§1.10 rule 4): a selected model is unloaded after ten idle
   minutes and reloaded by the next message. The plan's two lines ("stop … ten minutes
   after … preparation lease ends", "reacquire the model if its idle timeout has elapsed")
   are read together that way.
4. **Compute role with a window open** is still the compute role: no assistant server runs
   behind the setup page.
