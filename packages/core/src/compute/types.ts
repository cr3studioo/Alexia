// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shared vocabulary of remote compute (`docs/spec/remote-compute.md`): where a model runs,
 * which paired host that is, and what a job on it can be said to be doing.
 *
 * **Types and tiny pure helpers only.** Nothing here opens a socket, reads the store or starts
 * a process, so every other compute module — and the screen's own copy of these shapes — can
 * be written against this file alone.
 */

/** The interaction computer itself. Never a paired host's id: {@link HOST_ID} cannot match it. */
export const THIS_HOST = 'this'

/**
 * A paired host's id, minted by Alexia when the pairing is saved: lower-case letters and
 * digits, eight to thirty-two of them. **Not the endpoint's public key** — that is the native
 * sidecar's and travels in {@link PairedHost.endpointId} — so nothing here depends on how the
 * transport spells an identity, and an id is always safe in a URL, a kv key and a catalog id.
 */
export const HOST_ID = /^[a-z0-9]{8,32}$/

export const isHostId = (value: unknown): value is string => typeof value === 'string' && HOST_ID.test(value)

/** Where one model runs. `modelId` is the id the host's own engines know it by. */
export interface ExecutionTarget {
  hostId: typeof THIS_HOST | string
  modelId: string
}

/**
 * The provider row every paired host's models carry (`Model.provider`). One row for all of
 * them: the host is in the catalog id, and the row's `prepare()` reads it from there.
 */
export const REMOTE_PROVIDER = 'remote'

const QUALIFIED = /^@([a-z0-9]{8,32})\/(.+)$/s

/**
 * **A host-qualified catalog id**: the one string the router, the pin and the Models table
 * carry, so two hosts holding a model of the same name are two rows and never one.
 *
 * A model on this computer keeps the id it always had; a paired host's is `@<hostId>/<modelId>`.
 * That makes every id saved before hosts existed already a correct id for this computer, and
 * `@` begins no engine's model id — not an Ollama tag, not a Hugging Face repository.
 */
export function qualify(target: ExecutionTarget): string {
  if (target.modelId === '') throw new Error('An execution target needs a model id.')
  if (target.hostId === THIS_HOST) {
    if (QUALIFIED.test(target.modelId)) throw new Error('A model id on this computer cannot begin with a host prefix.')
    return target.modelId
  }
  if (!isHostId(target.hostId)) throw new Error('That is not a paired host id.')
  return `@${target.hostId}/${target.modelId}`
}

/** The inverse of {@link qualify}. Anything that is not host-qualified runs on this computer. */
export function parseCatalogId(id: string): ExecutionTarget {
  const found = QUALIFIED.exec(id)
  return found ? { hostId: found[1]!, modelId: found[2]! } : { hostId: THIS_HOST, modelId: id }
}

/** Whether a catalog id names a model on a paired host rather than on this computer. */
export const isRemoteId = (id: string): boolean => QUALIFIED.test(id)

export const sameTarget = (a: ExecutionTarget | undefined, b: ExecutionTarget | undefined): boolean =>
  a !== undefined && b !== undefined && a.hostId === b.hostId && a.modelId === b.modelId

/**
 * **A saved selection, read back as a target** — the whole migration to `hostId: 'this'`.
 *
 * Before hosts, the saved selection was a bare model id; now it is an {@link ExecutionTarget}.
 * A string is read as a catalog id, so an old value lands on this computer and a qualified one
 * keeps its host. Anything else is nothing saved, which is what a damaged value should mean.
 */
export function migrateSelection(saved: unknown): ExecutionTarget | undefined {
  if (typeof saved === 'string') return saved === '' ? undefined : parseCatalogId(saved)
  if (typeof saved !== 'object' || saved === null) return undefined
  const { hostId, modelId } = saved as Partial<ExecutionTarget>
  if (typeof modelId !== 'string' || modelId === '') return undefined
  if (hostId === THIS_HOST) return QUALIFIED.test(modelId) ? undefined : { hostId, modelId }
  return isHostId(hostId) ? { hostId, modelId } : undefined
}

/** What this installation is: the computer somebody talks to, or one that only computes for it. */
export const ROLES = ['interaction', 'compute'] as const
export type Role = (typeof ROLES)[number]

/** The stored role, read. Anything unrecognised is the role every install had before there were two. */
export const roleOf = (saved: unknown): Role => (ROLES as readonly unknown[]).includes(saved) ? (saved as Role) : 'interaction'

/** How the transport reaches a paired host right now, as the sidecar reports it. */
export type ConnectionState = 'direct' | 'relayed' | 'offline'

/** `Direct`, `Relayed` or `Offline`: the three words the screen shows, and no fourth. */
export const connectionLabel = (state: ConnectionState): string => state[0]!.toUpperCase() + state.slice(1)

/**
 * One pairing, as much of it as is not a secret. The endpoint's private key never reaches
 * TypeScript; this is the record that says whose public identity was trusted, and when.
 */
export interface PairedHost {
  id: string
  /** What the other computer called itself during pairing. Shown, never compared. */
  name: string
  /** The peer's public endpoint identity, exactly as the sidecar spelled it. Opaque here. */
  endpointId: string
  /** Which side of the pairing the *other* computer is. */
  peerRole: Role
  pairedAt: number
  lastSeenAt?: number
  /** The other side's platform and Alexia version at the last handshake, for the host list. */
  platform?: string
  appVersion?: string
}

/**
 * Why a host cannot serve, in the five words the plan requires to be shown as themselves, and
 * the few more a refusal needs. A code, never a sentence: the sentence is the screen's.
 */
export const COMPUTE_ERRORS = [
  'offline',
  'busy',
  'incompatible-version',
  'setup-required',
  'worker-failure',
  'unpaired',
  'cancelled',
  'interrupted',
  'not-found',
  'refused',
  'expired',
] as const
export type ComputeErrorCode = (typeof COMPUTE_ERRORS)[number]

export interface ComputeFailure {
  code: ComputeErrorCode
  /** One line for a person. No host path, no prompt, no pairing code. */
  message: string
}

/** A {@link ComputeFailure} that can be thrown, so a refusal keeps its code across an `await`. */
export class ComputeError extends Error {
  constructor(readonly code: ComputeErrorCode, message: string) {
    super(message)
    this.name = 'ComputeError'
  }

  failure(): ComputeFailure {
    return { code: this.code, message: this.message }
  }
}

/** Where a selected target stands, for the mode switch and the picker. */
export type TargetPhase =
  | 'connecting'
  | 'setup-required'
  | 'queued'
  | 'loading'
  | 'ready'
  | 'offline'
  | 'busy'
  | 'incompatible-version'
  | 'worker-failure'

export interface TargetStatus {
  target: ExecutionTarget
  phase: TargetPhase
  connection: ConnectionState
  /** One line for a person. */
  message: string
  /** Its place in the host's queue while `queued`, counted from one. */
  position?: number
}

/** Every phase that will not change until somebody does something. */
export const settled = (phase: TargetPhase): boolean => !['connecting', 'queued', 'loading'].includes(phase)

/** The pairing in progress, as the screen is told it. The code itself appears only while it is shown. */
export type PairingPhase = 'waiting' | 'connecting' | 'verifying' | 'paired' | 'failed' | 'expired' | 'cancelled'

export interface PairingStatus {
  phase: PairingPhase
  /** Shown by the computer that opened the pairing, and typed on the other. Never logged. */
  code?: string
  expiresAt?: number
  peerName?: string
  /** The host saved by a pairing that ended `paired`. */
  hostId?: string
  message?: string
}

/** A pairing code lasts five minutes and one attempt. */
export const PAIRING_CODE_MS = 5 * 60 * 1000
/** An Alexia-owned worker is stopped this long after its last job or preparation lease ended. */
export const IDLE_STOP_MS = 10 * 60 * 1000
/** How long unfinished jobs survive a lost control session before they are cancelled. */
export const RECONNECT_GRACE_MS = 15_000
/** How long a finished job's artifacts wait on the host to be fetched. */
export const ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1000

/** A heavy job holds the host's one compute slot; a light one (a download, a probe) does not. */
export type JobWeight = 'heavy' | 'light'

/** What a job is: one streamed answer, one run of a worker's operation, or one explicit install. */
export type JobKind = 'chat' | 'operation' | 'setup'

/**
 * Every state a job can be in. `interrupted` is the host having lost the job — a restart, or
 * the reconnect grace running out — and it is final: nothing here is ever resubmitted for you.
 */
export const JOB_STATES = ['queued', 'preparing', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const
export type JobState = (typeof JOB_STATES)[number]

export const finished = (state: JobState): boolean => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state)

export interface JobProgress {
  progress: number
  total?: number
  message?: string
}

export interface JobSnapshot {
  id: string
  kind: JobKind
  weight: JobWeight
  state: JobState
  /** The capability or model the job is for, as a label. Never a prompt. */
  label: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  progress?: JobProgress
  failure?: ComputeFailure
  /** What it made, once `succeeded`. */
  artifacts?: ArtifactRef[]
}

/** The host's queue as shown: what is running, then what waits, first in first out. */
export interface QueueSnapshot {
  running?: JobSnapshot
  waiting: JobSnapshot[]
  /** Set while the host's owner has paused it from the tray: jobs queue and none starts. */
  paused: boolean
}

/** A job's place in the queue, counted from one: zero while it runs, undefined when it is not there. */
export function queuePosition(queue: QueueSnapshot, jobId: string): number | undefined {
  if (queue.running?.id === jobId) return 0
  const at = queue.waiting.findIndex((job) => job.id === jobId)
  return at < 0 ? undefined : at + 1
}

/**
 * A file a job read or made, by id. **No path**: the host's filesystem is never described to
 * the interaction computer, and the name is a display name with no directory in it.
 */
export interface ArtifactRef {
  id: string
  jobId: string
  name: string
  mime: string
  bytes: number
  /** Lower-case hex SHA-256 of the bytes, checked by whoever receives them. */
  sha256: string
  /** When the host deletes its copy if nobody acknowledged a transfer first. */
  expiresAt: number
}

export const expired = (artifact: Pick<ArtifactRef, 'expiresAt'>, at: number = Date.now()): boolean => at >= artifact.expiresAt

/** One thing a host is missing before a capability or a model can run there. */
export interface SetupRequirement {
  /** Stable for as long as the requirement stands, and what an install names. */
  id: string
  kind: 'runtime' | 'model' | 'dependency'
  title: string
  detail?: string
  /** The download's size where it is known. Shown before anything is installed. */
  bytes?: number
  /** `install` is a button Alexia can carry out on the host; `instructions` is a thing only a person can do there. */
  action: 'install' | 'instructions'
  instructions?: string
  /** The capabilities waiting on it. */
  blocks: string[]
}

/** The host's hardware, as the fit check needs it. The same facts `machine.ts` gathers, probed there. */
export interface HostMachine {
  platform: string
  arch: string
  chip: string
  appleSilicon: boolean
  ramBytes: number
  freeRamBytes?: number
  freeDiskBytes: number
  diskKnown?: boolean
  budgetBytes: number
  cpuCores?: number
  gpus?: { name: string; vramBytes?: number; freeVramBytes?: number }[]
}

/** One model installed on a host, as much of it as a catalog row needs. `id` is the host's own, unqualified. */
export interface HostModel {
  id: string
  name: string
  /** Which of the host's engines serves it, by that engine's provider id there. */
  engine: string
  context: number
  supportsTools: boolean
  modality: string[]
  params?: number
  quant?: string
  diskBytes?: number
  abliterated?: boolean
  /** Whether it is in memory right now. */
  loaded: boolean
}

/** One operation a host's installed workers can run, by capability name and never by who provides it. */
export interface HostCapability {
  cap: string
  summary: string
  weight: JobWeight
  /** False while something in {@link HostInventory.setup} blocks it. */
  ready: boolean
}

/** Everything a paired host says about itself. Sent whole on handshake and again whenever it changes. */
export interface HostInventory {
  name: string
  appVersion: string
  machine: HostMachine
  models: HostModel[]
  capabilities: HostCapability[]
  setup: SetupRequirement[]
  /** Rises by one with every change, so a stale copy is recognisable. */
  revision: number
}

/** A paired host as the host list shows it: the record, how it is reached, and what it last said. */
export interface HostView {
  host: PairedHost
  connection: ConnectionState
  /** Why it cannot serve, when it cannot. Absent is able. */
  failure?: ComputeFailure
  inventory?: HostInventory
}
