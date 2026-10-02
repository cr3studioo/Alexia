// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ArtifactRef,
  ComputeFailure,
  HostInventory,
  JobProgress,
  JobSnapshot,
  QueueSnapshot,
  TargetPhase,
} from './types.js'

/**
 * The compute protocol: what an interaction computer and a compute host say to each other
 * once the native sidecar has connected them (`docs/spec/remote-compute.md`).
 *
 * **It is spoken between two TypeScript processes and the transport never reads it.** The
 * sidecar forwards a stream of bytes for one of the four registered {@link STREAM_KINDS} and
 * nothing else; everything below is what those bytes mean. Types and pure helpers only.
 */

/**
 * Bumped when a message changes meaning or a required one is added. Additive, optional fields
 * do not move it. Both ends say the range they speak and use the highest both know.
 */
export const COMPUTE_PROTOCOL_VERSION = 1
/** The oldest version this build still speaks. */
export const COMPUTE_PROTOCOL_MIN = 1

export interface ProtocolRange {
  min: number
  max: number
}

export const SPEAKS: ProtocolRange = { min: COMPUTE_PROTOCOL_MIN, max: COMPUTE_PROTOCOL_VERSION }

/** The version two ends will speak, or undefined when no version is common to both. */
export function negotiate(theirs: ProtocolRange, mine: ProtocolRange = SPEAKS): number | undefined {
  const version = Math.min(mine.max, theirs.max)
  const valid = [mine.min, mine.max, theirs.min, theirs.max].every((n) => Number.isSafeInteger(n) && n > 0)
  return valid && mine.min <= mine.max && theirs.min <= theirs.max && version >= Math.max(mine.min, theirs.min) ? version : undefined
}

/**
 * The only streams the sidecar will forward, each opened for one purpose and closed with it:
 * `control` is the long-lived session, `infer` is one streamed answer, `job` is one worker
 * job's events, and `artifact` is one file's bytes in one direction.
 */
export const STREAM_KINDS = ['control', 'infer', 'job', 'artifact'] as const
export type StreamKind = (typeof STREAM_KINDS)[number]

export const isStreamKind = (value: unknown): value is StreamKind => (STREAM_KINDS as readonly unknown[]).includes(value)

/** A frame is one JSON value on one line. A megabyte is far more than any message here needs. */
export const FRAME_MAX_BYTES = 1024 * 1024

const NEWLINE = 0x0a

/** One message as the bytes that go on a stream: UTF-8 JSON and a newline. */
export function encodeFrame(message: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`)
  if (bytes.length > FRAME_MAX_BYTES) throw new Error('That message is too large for one frame.')
  return bytes
}

/**
 * The first frame in `buffer` and the bytes after it, or undefined until a whole frame has
 * arrived. The rest is handed back untouched because after some frames it is not frames at
 * all: an answer's bytes and an artifact's follow their head frame raw.
 *
 * Throws on a frame that is too long or is not JSON; the caller closes the stream.
 */
export function splitFrame(buffer: Uint8Array): { frame: unknown; rest: Uint8Array } | undefined {
  const end = buffer.indexOf(NEWLINE)
  if (end < 0) {
    if (buffer.length >= FRAME_MAX_BYTES) throw new Error('A frame exceeded the size limit.')
    return undefined
  }
  if (end + 1 > FRAME_MAX_BYTES) throw new Error('A frame exceeded the size limit.')
  return { frame: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end))), rest: buffer.subarray(end + 1) }
}

/** What the interaction computer says first on the control stream. */
export interface Hello {
  protocol: ProtocolRange
  appVersion: string
  /** This computer's name, for the host's tray. */
  name: string
  /** Jobs this controller still wants the outcome of, after a reconnect. Never a request to run them again. */
  resume?: string[]
}

/** The host's answer to a {@link Hello} it accepts. */
export interface Welcome {
  /** The version both ends now speak. */
  protocol: number
  appVersion: string
  name: string
  inventory: HostInventory
  queue: QueueSnapshot
  /** Where each job named in `resume` stands. One the host no longer knows is reported `interrupted`. */
  jobs: JobSnapshot[]
  /** This host accepts the optional controller farewell that revokes its pairing. */
  controllerUnpair?: true
}

/**
 * The first frame on every stream, which says what the stream is for. The host refuses a
 * stream whose first frame is anything else, and every kind but `control` is refused while
 * no control session from the same endpoint is open.
 */
export type StreamOpen =
  | { stream: 'control'; hello: Hello }
  /** Then `bodyBytes` of a chat-completions request body, raw. Answered by an {@link InferHead} and the answer's bytes. */
  | { stream: 'infer'; jobId: string; leaseId: string; bodyBytes: number }
  | { stream: 'job'; submit: JobSubmit }
  /** Hear a job already submitted: every {@link JobEvent} after `after`, then the rest as they happen. */
  | { stream: 'job'; attach: string; after?: number }
  /** Then `bytes` of the file, raw. Answered by an {@link ArtifactPutResult}. */
  | { stream: 'artifact'; put: ArtifactPut }
  /** Answered by an {@link ArtifactHead} and the file's bytes from `offset`. */
  | { stream: 'artifact'; get: string; offset?: number }

/** What the host says first on a control stream: the session, or why there is not one. */
export type ControlOpened = { type: 'welcome'; welcome: Welcome } | { type: 'refused'; failure: ComputeFailure }

/** The key an operation's arguments use to name a staged input: `{ "$artifact": "<id>" }`. The host puts the file there. */
export const ARTIFACT_ARG = '$artifact'

/** One run of a worker's operation, by capability. The job id is the controller's, so asking twice is one job. */
export interface JobSubmit {
  jobId: string
  cap: string
  arguments?: Record<string, unknown>
  /** Artifacts already put for this job id. */
  inputs?: string[]
}

/** What a job says while it runs. `seq` rises by one per event of a job, so a reattach can ask for what it missed. */
export type JobEvent =
  | { type: 'state'; seq: number; job: JobSnapshot }
  | { type: 'progress'; seq: number; progress: JobProgress }
  | { type: 'output'; seq: number; output: JobOutput }
  /** The last event of a job: its final snapshot, with its artifacts or its failure. */
  | { type: 'done'; seq: number; job: JobSnapshot }

/** The largest picture a job may show of work in progress, as base64 characters. */
export const PREVIEW_MAX_CHARS = 256 * 1024

export type JobOutput =
  | { type: 'text'; text: string }
  | { type: 'artifact'; artifact: ArtifactRef }
  /** A picture of the work while it is still work. Replaced by the next one and never stored. */
  | { type: 'preview'; mime: string; data: string }

/** The one thing a controller may say on a job stream after opening it. */
export interface JobCancel {
  type: 'cancel'
}

/** What precedes an answer's bytes, or says there will be none. */
export type InferHead =
  /** The engine's own status and content type; its body follows, forwarded as it arrives. */
  | { type: 'head'; status: number; contentType: string }
  | { type: 'refused'; failure: ComputeFailure }

export interface ArtifactPut {
  /** The job these inputs are for. Inputs whose job is never submitted are deleted as abandoned. */
  jobId: string
  name: string
  mime: string
  bytes: number
  sha256: string
}

export type ArtifactPutResult = { type: 'stored'; artifact: ArtifactRef } | { type: 'refused'; failure: ComputeFailure }

export type ArtifactHead = { type: 'head'; artifact: ArtifactRef; offset: number } | { type: 'refused'; failure: ComputeFailure }

/** A chat model held ready on the host for this controller, from selection until release or the idle stop. */
export interface Lease {
  leaseId: string
  modelId: string
  phase: Extract<TargetPhase, 'queued' | 'loading' | 'ready' | 'setup-required' | 'busy' | 'worker-failure'> | 'released'
  message: string
  position?: number
  failure?: ComputeFailure
}

/**
 * The host's model picker, asked from the interaction computer: the operations the local
 * picker already has, run against the host's disk and the host's hardware. Importing a file
 * by path and storing a download token are not among them; both are done at the host.
 */
export const HOST_MODEL_OPS = ['overview', 'search', 'repo', 'context', 'configure', 'install', 'progress', 'cancel', 'benchmark', 'remove'] as const
export type HostModelOp = (typeof HOST_MODEL_OPS)[number]

export const isHostModelOp = (value: unknown): value is HostModelOp => (HOST_MODEL_OPS as readonly unknown[]).includes(value)

/** Every request on the control stream, and what each is answered with. */
export interface ControlCalls {
  'inventory.get': { params: Record<string, never>; result: HostInventory }
  'queue.get': { params: Record<string, never>; result: QueueSnapshot }
  /** Load a chat model and keep it. Answers once the lease exists; its progress arrives as `lease` events. */
  prepare: { params: { leaseId: string; modelId: string }; result: Lease }
  release: { params: { leaseId: string }; result: Record<string, never> }
  'job.status': { params: { jobId: string }; result: JobSnapshot }
  /** A queued job is removed at once; a running one is cancelled in its worker. Asking again is harmless. */
  'job.cancel': { params: { jobId: string }; result: JobSnapshot }
  /** Install one {@link HostInventory.setup} requirement, as a job the controller named. */
  'setup.install': { params: { jobId: string; requirementId: string }; result: JobSnapshot }
  models: { params: { op: HostModelOp; args?: Record<string, unknown> }; result: unknown }
  /** The bytes arrived and were checked: the host may delete its copies now. */
  'artifact.ack': { params: { artifactIds: string[] }; result: Record<string, never> }
  ping: { params: Record<string, never>; result: Record<string, never> }
}
export type ControlMethod = keyof ControlCalls

export type ControlRequest = { [M in ControlMethod]: { id: number; method: M; params: ControlCalls[M]['params'] } }[ControlMethod]

/** Optional in version 1; sent only when {@link Welcome.controllerUnpair} is advertised. */
export type ControllerBye = { event: 'bye'; reason: 'unpaired' }
export type ControllerFrame = ControlRequest | ControllerBye

export type ControlResponse =
  | { [M in ControlMethod]: { id: number; ok: true; result: ControlCalls[M]['result'] } }[ControlMethod]
  | { id: number; ok: false; failure: ComputeFailure }

/** Why a host ends a session itself. `unpaired` is final: the controller forgets nothing but stops asking. */
export type ByeReason = 'unpaired' | 'paused' | 'role-switch' | 'quitting' | 'updating'

/** What the host says unasked. Inventory and queue are sent when they change, never on a timer. */
export type ControlEvent =
  | { event: 'inventory'; inventory: HostInventory }
  | { event: 'queue'; queue: QueueSnapshot }
  | { event: 'job'; job: JobSnapshot }
  | { event: 'lease'; lease: Lease }
  | { event: 'bye'; reason: ByeReason }

/** Everything a host writes on a control stream after {@link ControlOpened}. */
export type HostFrame = ControlResponse | ControlEvent

export const isControlEvent = (frame: HostFrame): frame is ControlEvent => 'event' in frame

export const answered = <M extends ControlMethod>(id: number, result: ControlCalls[M]['result']): ControlResponse =>
  ({ id, ok: true, result }) as ControlResponse

export const refused = (id: number, failure: ComputeFailure): ControlResponse => ({ id, ok: false, failure })
