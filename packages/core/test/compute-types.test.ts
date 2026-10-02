// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import {
  answered, COMPUTE_PROTOCOL_MIN, COMPUTE_PROTOCOL_VERSION, encodeFrame, FRAME_MAX_BYTES, isControlEvent, isHostModelOp,
  isStreamKind, negotiate, refused, splitFrame, type ControllerFrame, type HostFrame,
} from '../src/compute/protocol.js'
import {
  ARTIFACT_RETENTION_MS, ComputeError, connectionLabel, expired, finished, IDLE_STOP_MS, isHostId, isRemoteId, JOB_STATES,
  migrateSelection, PAIRING_CODE_MS, parseCatalogId, qualify, queuePosition, RECONNECT_GRACE_MS, roleOf, sameTarget, settled,
  THIS_HOST, type JobSnapshot, type QueueSnapshot,
} from '../src/compute/types.js'

const HOST = 'k3x9q2m7vd4p'
const job = (id: string, state: JobSnapshot['state'] = 'queued'): JobSnapshot =>
  ({ id, kind: 'operation', weight: 'heavy', state, label: 'image.generate', createdAt: 1 })

test('a model on this computer keeps its id, and a paired host qualifies it', () => {
  expect(qualify({ hostId: THIS_HOST, modelId: 'llama/qwen3-8b:q4_k_m' })).toBe('llama/qwen3-8b:q4_k_m')
  expect(qualify({ hostId: HOST, modelId: 'llama/qwen3-8b:q4_k_m' })).toBe(`@${HOST}/llama/qwen3-8b:q4_k_m`)
  expect(parseCatalogId('llama/qwen3-8b:q4_k_m')).toEqual({ hostId: 'this', modelId: 'llama/qwen3-8b:q4_k_m' })
  expect(parseCatalogId(`@${HOST}/llama/qwen3-8b:q4_k_m`)).toEqual({ hostId: HOST, modelId: 'llama/qwen3-8b:q4_k_m' })
})

test('identical model names on different hosts are different catalog ids', () => {
  const ids = [THIS_HOST, HOST, 'another0host'].map((hostId) => qualify({ hostId, modelId: 'qwen3:8b' }))
  expect(new Set(ids).size).toBe(3)
  for (const id of ids) expect(qualify(parseCatalogId(id))).toBe(id)
  expect(isRemoteId(ids[0]!)).toBe(false)
  expect(isRemoteId(ids[1]!)).toBe(true)
})

test('ids that only resemble a host prefix stay on this computer', () => {
  // A registry with a port, an upper-case host, a host too short to be one, and no model after it.
  for (const id of ['localhost:5000/library/qwen3:8b', '@K3X9Q2M7VD4P/model', '@short/model', `@${HOST}/`, '@', 'hf.co/org/repo:Q4_K_M']) {
    expect(parseCatalogId(id)).toEqual({ hostId: 'this', modelId: id })
    expect(isRemoteId(id)).toBe(false)
  }
})

test('qualify refuses what it could not read back', () => {
  expect(() => qualify({ hostId: HOST, modelId: '' })).toThrow()
  expect(() => qualify({ hostId: 'Not A Host', modelId: 'qwen3:8b' })).toThrow()
  expect(() => qualify({ hostId: THIS_HOST, modelId: `@${HOST}/qwen3:8b` })).toThrow()
})

test('host ids are lower-case letters and digits, and never the word for this computer', () => {
  expect(isHostId(HOST)).toBe(true)
  for (const bad of [THIS_HOST, '', 'short', 'has-hyphen-in-it', 'UPPERCASE1', 'a'.repeat(33), 7, undefined]) expect(isHostId(bad)).toBe(false)
})

test('a selection saved before hosts existed migrates to this computer', () => {
  expect(migrateSelection('llama/qwen3-8b:q4_k_m')).toEqual({ hostId: 'this', modelId: 'llama/qwen3-8b:q4_k_m' })
  expect(migrateSelection('qwen3:8b')).toEqual({ hostId: 'this', modelId: 'qwen3:8b' })
  expect(migrateSelection(`@${HOST}/qwen3:8b`)).toEqual({ hostId: HOST, modelId: 'qwen3:8b' })
  expect(migrateSelection({ hostId: HOST, modelId: 'qwen3:8b' })).toEqual({ hostId: HOST, modelId: 'qwen3:8b' })
  expect(migrateSelection({ hostId: 'this', modelId: 'qwen3:8b', extra: true })).toEqual({ hostId: 'this', modelId: 'qwen3:8b' })
})

test('a damaged saved selection is nothing saved', () => {
  for (const bad of [undefined, null, '', 7, [], {}, { hostId: HOST }, { hostId: 'Nope', modelId: 'a' }, { hostId: HOST, modelId: '' },
    { modelId: 'a' }, { hostId: 'this', modelId: `@${HOST}/a` }]) {
    expect(migrateSelection(bad)).toBeUndefined()
  }
})

test('targets compare by host and model, and an absent one equals nothing', () => {
  expect(sameTarget({ hostId: HOST, modelId: 'a' }, { hostId: HOST, modelId: 'a' })).toBe(true)
  expect(sameTarget({ hostId: HOST, modelId: 'a' }, { hostId: 'this', modelId: 'a' })).toBe(false)
  expect(sameTarget(undefined, undefined)).toBe(false)
})

test('an unrecognised stored role is the interaction role', () => {
  expect(roleOf('compute')).toBe('compute')
  expect(roleOf('interaction')).toBe('interaction')
  for (const other of [undefined, null, 'host', 3]) expect(roleOf(other)).toBe('interaction')
})

test('connection states are shown as Direct, Relayed and Offline', () => {
  expect((['direct', 'relayed', 'offline'] as const).map(connectionLabel)).toEqual(['Direct', 'Relayed', 'Offline'])
})

test('the agreed durations are the constants', () => {
  expect(PAIRING_CODE_MS).toBe(300_000)
  expect(IDLE_STOP_MS).toBe(600_000)
  expect(RECONNECT_GRACE_MS).toBe(15_000)
  expect(ARTIFACT_RETENTION_MS).toBe(86_400_000)
})

test('four job states are final and the rest are not', () => {
  expect(JOB_STATES.filter(finished)).toEqual(['succeeded', 'failed', 'cancelled', 'interrupted'])
  expect(settled('ready')).toBe(true)
  expect(settled('offline')).toBe(true)
  expect(settled('setup-required')).toBe(true)
  for (const moving of ['connecting', 'queued', 'loading'] as const) expect(settled(moving)).toBe(false)
})

test('a place in the queue counts from one, and the running job is at zero', () => {
  const queue: QueueSnapshot = { running: job('a', 'running'), waiting: [job('b'), job('c')], paused: false }
  expect(queuePosition(queue, 'a')).toBe(0)
  expect(queuePosition(queue, 'b')).toBe(1)
  expect(queuePosition(queue, 'c')).toBe(2)
  expect(queuePosition(queue, 'd')).toBeUndefined()
  expect(queuePosition({ waiting: [], paused: true }, 'a')).toBeUndefined()
})

test('an artifact expires at its time and not before', () => {
  expect(expired({ expiresAt: 100 }, 99)).toBe(false)
  expect(expired({ expiresAt: 100 }, 100)).toBe(true)
})

test('a compute error keeps its code', () => {
  const error = new ComputeError('setup-required', 'Install the runner on that computer first.')
  expect(error).toBeInstanceOf(Error)
  expect(error.failure()).toEqual({ code: 'setup-required', message: 'Install the runner on that computer first.' })
})

test('two ends speak the highest version both know, or none', () => {
  expect(negotiate({ min: COMPUTE_PROTOCOL_MIN, max: COMPUTE_PROTOCOL_VERSION })).toBe(COMPUTE_PROTOCOL_VERSION)
  expect(negotiate({ min: 1, max: 5 }, { min: 2, max: 3 })).toBe(3)
  expect(negotiate({ min: 2, max: 3 }, { min: 1, max: 5 })).toBe(3)
  expect(negotiate({ min: 4, max: 6 }, { min: 1, max: 3 })).toBeUndefined()
  expect(negotiate({ min: 1, max: 2 }, { min: 3, max: 4 })).toBeUndefined()
  for (const bad of [{ min: 0, max: 1 }, { min: 2, max: 1 }, { min: 1, max: 1.5 }, { min: NaN, max: 1 }]) expect(negotiate(bad, { min: 1, max: 3 })).toBeUndefined()
})

test('the optional controller farewell stays compatible with compute protocol version one', () => {
  const bye: ControllerFrame = { event: 'bye', reason: 'unpaired' }
  expect(splitFrame(encodeFrame(bye))?.frame).toEqual(bye)
  expect(COMPUTE_PROTOCOL_MIN).toBe(1)
  expect(COMPUTE_PROTOCOL_VERSION).toBe(1)
  expect(negotiate({ min: 1, max: 1 })).toBe(1)
})

test('a frame is one line of JSON, and the bytes after it are handed back untouched', () => {
  const head = encodeFrame({ type: 'head', status: 200, contentType: 'text/event-stream' })
  expect(head.at(-1)).toBe(0x0a)
  const body = new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x0a, 0xff])
  const found = splitFrame(new Uint8Array([...head, ...body]))
  expect(found?.frame).toEqual({ type: 'head', status: 200, contentType: 'text/event-stream' })
  expect([...found!.rest]).toEqual([...body])
})

test('a frame arriving in pieces is not read until it is whole', () => {
  const frame = encodeFrame({ event: 'queue', queue: { waiting: [], paused: false }, text: 'žluťoučký \n kůň' })
  expect(splitFrame(frame.subarray(0, frame.length - 1))).toBeUndefined()
  expect(splitFrame(new Uint8Array())).toBeUndefined()
  expect(splitFrame(frame)).toEqual({ frame: { event: 'queue', queue: { waiting: [], paused: false }, text: 'žluťoučký \n kůň' }, rest: new Uint8Array() })
})

test('an oversized or malformed frame is refused rather than buffered', () => {
  expect(() => encodeFrame({ text: 'x'.repeat(FRAME_MAX_BYTES) })).toThrow()
  expect(() => splitFrame(new Uint8Array(FRAME_MAX_BYTES).fill(0x20))).toThrow()
  expect(() => splitFrame(new Uint8Array([...new Uint8Array(FRAME_MAX_BYTES).fill(0x20), 0x0a]))).toThrow()
  expect(() => splitFrame(new TextEncoder().encode('not json\n'))).toThrow()
  expect(() => splitFrame(new Uint8Array([0xff, 0xfe, 0x0a]))).toThrow()
})

test('only the four registered streams and the listed picker operations are recognised', () => {
  for (const kind of ['control', 'infer', 'job', 'artifact']) expect(isStreamKind(kind)).toBe(true)
  for (const kind of ['shell', 'plugin', '', undefined]) expect(isStreamKind(kind)).toBe(false)
  expect(isHostModelOp('install')).toBe(true)
  for (const op of ['import', 'token', 'import-preview']) expect(isHostModelOp(op)).toBe(false)
})

test('answers and events are told apart on the control stream', () => {
  const frames: HostFrame[] = [
    answered<'ping'>(1, {}),
    refused(2, { code: 'busy', message: 'That computer is busy.' }),
    { event: 'bye', reason: 'unpaired' },
  ]
  expect(frames.map(isControlEvent)).toEqual([false, false, true])
  expect(frames[1]).toEqual({ id: 2, ok: false, failure: { code: 'busy', message: 'That computer is busy.' } })
})
