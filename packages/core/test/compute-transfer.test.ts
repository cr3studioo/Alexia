// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'
import { afterEach, expect, test, vi } from 'vitest'
import { memoryConnect } from '../src/compute/connect.js'
import { Controller, Frames } from '../src/compute/controller.js'
import { Hosts } from '../src/compute/hosts.js'
import { encodeFrame, type ArtifactHead, type ArtifactPut, type ArtifactPutResult, type ControlRequest, type StreamKind, type StreamOpen } from '../src/compute/protocol.js'
import { fetchArtifact, upload } from '../src/compute/transfer.js'
import { ComputeError, type ArtifactRef, type HostInventory } from '../src/compute/types.js'
import { Store } from '../src/store.js'

const inventory: HostInventory = {
  name: 'Studio', appVersion: '2.0.0', revision: 1, models: [], capabilities: [], setup: [],
  machine: { platform: 'win32', arch: 'x64', chip: 'Test', appleSilicon: false, ramBytes: 64, freeDiskBytes: 64, budgetBytes: 32 },
}
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const artifact = (bytes: Uint8Array, more: Partial<ArtifactRef> = {}): ArtifactRef =>
  ({ id: ID, jobId: 'job-1', name: 'render.png', mime: 'image/png', bytes: bytes.length, sha256: sha256(bytes), expiresAt: 9e12, ...more })

interface Opened { kind: StreamKind; open: StreamOpen; stream: Duplex; frames: Frames }

/** A compute host that says exactly what a test tells it to, over the in-memory transport. */
class Script {
  readonly opened: Opened[] = []
  readonly requests: ControlRequest[] = []
  /** What a `get` is answered with: a head, then these bytes. `cut` breaks the stream after them. */
  serve: (get: string, offset: number) => { head: ArtifactHead; bytes?: Uint8Array; cut?: boolean } = () => ({ head: { type: 'refused', failure: { code: 'not-found', message: 'No such artifact.' } } })
  /** What a `put` is answered with, once its bytes have been read. */
  store: (put: ArtifactPut, bytes: Buffer) => ArtifactPutResult = (put, bytes) =>
    ({ type: 'stored', artifact: { id: ID, jobId: put.jobId, name: put.name, mime: put.mime, bytes: bytes.length, sha256: sha256(bytes), expiresAt: 9e12 } })
  readonly received: { put: ArtifactPut; bytes: Buffer }[] = []

  async accept(stream: Duplex, kind: StreamKind): Promise<void> {
    const frames = new Frames(stream)
    const open = await frames.next() as StreamOpen
    this.opened.push({ kind, open, stream, frames })
    if (open.stream === 'control') {
      stream.write(encodeFrame({ type: 'welcome', welcome: { protocol: 1, appVersion: '2.0.0', name: 'Studio', inventory, queue: { waiting: [], paused: false }, jobs: [] } }))
      for (;;) {
        const request = await frames.next().catch(() => undefined) as ControlRequest | undefined
        if (!request) return
        this.requests.push(request)
        stream.write(encodeFrame({ id: request.id, ok: true, result: {} }))
      }
    }
    if (open.stream !== 'artifact') return
    if ('get' in open) {
      const { head, bytes, cut } = this.serve(open.get, open.offset ?? 0)
      stream.write(encodeFrame(head))
      if (bytes) stream.write(bytes)
      if (cut) setTimeout(() => { stream.destroy() }, 20)
      else stream.end()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of frames.bytes()) {
      chunks.push(Buffer.from(chunk))
      size += chunk.length
      if (size >= open.put.bytes) break
    }
    const bytes = Buffer.concat(chunks)
    this.received.push({ put: open.put, bytes })
    stream.end(encodeFrame(this.store(open.put, bytes)))
  }

  gets(): StreamOpen[] { return this.opened.flatMap((one) => one.open.stream === 'artifact' && 'get' in one.open ? [one.open] : []) }
  acks(): string[][] { return this.requests.flatMap((request) => request.method === 'artifact.ack' ? [request.params.artifactIds] : []) }
}

const closing: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close() })

async function rig() {
  const store = new Store(':memory:')
  const { a, b } = memoryConnect()
  const [mine, theirs] = [await a.identity(), await b.identity()]
  await a.allow([theirs])
  await b.allow([mine])
  const hosts = new Hosts(store, 'interaction')
  const host = hosts.add({ name: 'Studio', endpointId: theirs, peerRole: 'compute' }, 1)
  const script = new Script()
  b.accept((stream, from) => { void script.accept(stream, from.kind) })
  const controller = new Controller({ connect: a, hosts, name: 'Laptop', appVersion: '1.0.0', timer: () => ({ clear: () => {} }) })
  const dir = mkdtempSync(join(tmpdir(), 'alexia-transfer-'))
  closing.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close(), () => a.close(), () => b.close(), () => controller.close())
  return { controller, script, host, dir, toDir: join(dir, 'home', 'outputs') }
}

const whole = (bytes: Uint8Array, about: ArtifactRef) => (_get: string, offset: number) => ({ head: { type: 'head' as const, artifact: about, offset }, bytes: bytes.subarray(offset) })
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

test('a fetched artifact is hash-verified, written into this computer\'s storage, and acknowledged', async () => {
  const { controller, script, host, toDir } = await rig()
  // Larger than one stream window, so the bytes arrive in pieces and the far side is slowed by this one.
  const bytes = randomBytes(300 * 1024)
  const about = artifact(bytes)
  script.serve = whole(bytes, about)
  const path = await fetchArtifact(controller, host.id, about, toDir)
  expect(path).toBe(join(toDir, 'render.png'))
  expect(readFileSync(path).equals(bytes)).toBe(true)
  expect(readdirSync(toDir)).toEqual(['render.png'])
  expect(script.gets()).toEqual([{ stream: 'artifact', get: ID }])
  await vi.waitFor(() => expect(script.acks()).toEqual([[ID]]))
})

test('a bad hash is refused, leaves no file, and is not acknowledged', async () => {
  const { controller, script, host, toDir } = await rig()
  const bytes = randomBytes(4096)
  const about = artifact(bytes)
  const wrong = Buffer.from(bytes)
  wrong[100] = wrong[100]! ^ 0xff
  script.serve = whole(wrong, about)
  await expect(fetchArtifact(controller, host.id, about, toDir)).rejects.toMatchObject({ code: 'refused' })
  expect(readdirSync(toDir)).toEqual([])
  await quiet()
  expect(script.acks()).toEqual([])
  expect(script.requests).toEqual([])
})

test('a file longer than it was said to be is refused the same way', async () => {
  const { controller, script, host, toDir } = await rig()
  const bytes = randomBytes(1000)
  const about = artifact(bytes)
  script.serve = whole(Buffer.concat([bytes, Buffer.from('more')]), about)
  await expect(fetchArtifact(controller, host.id, about, toDir)).rejects.toMatchObject({ code: 'refused' })
  expect(readdirSync(toDir)).toEqual([])
  expect(script.acks()).toEqual([])
})

test('a transfer that breaks keeps what arrived, and the next fetch resumes from that offset', async () => {
  const { controller, script, host, toDir } = await rig()
  const bytes = randomBytes(10_000)
  const about = artifact(bytes)
  script.serve = () => ({ head: { type: 'head', artifact: about, offset: 0 }, bytes: bytes.subarray(0, 6000), cut: true })
  await expect(fetchArtifact(controller, host.id, about, toDir)).rejects.toMatchObject({ code: 'interrupted' })
  expect(readdirSync(toDir)).toEqual([`${ID}.part`])
  expect(readFileSync(join(toDir, `${ID}.part`)).equals(bytes.subarray(0, 6000))).toBe(true)
  expect(script.acks()).toEqual([])

  script.serve = whole(bytes, about)
  const path = await fetchArtifact(controller, host.id, about, toDir)
  expect(script.gets().at(-1)).toEqual({ stream: 'artifact', get: ID, offset: 6000 })
  expect(readFileSync(path).equals(bytes)).toBe(true)
  expect(readdirSync(toDir)).toEqual(['render.png'])
  await vi.waitFor(() => expect(script.acks()).toEqual([[ID]]))
})

test('a partial file that is not the start of the artifact fails the check and is thrown away', async () => {
  const { controller, script, host, toDir } = await rig()
  const bytes = randomBytes(5000)
  const about = artifact(bytes)
  script.serve = whole(bytes, about)
  // First leave a partial file behind, then spoil it.
  script.serve = () => ({ head: { type: 'head', artifact: about, offset: 0 }, bytes: bytes.subarray(0, 2000), cut: true })
  await expect(fetchArtifact(controller, host.id, about, toDir)).rejects.toMatchObject({ code: 'interrupted' })
  writeFileSync(join(toDir, `${ID}.part`), randomBytes(2000))
  script.serve = whole(bytes, about)
  await expect(fetchArtifact(controller, host.id, about, toDir)).rejects.toMatchObject({ code: 'refused' })
  expect(readdirSync(toDir)).toEqual([])
  expect(script.acks()).toEqual([])
  // With the bad start gone, the next fetch is a whole one.
  expect(readFileSync(await fetchArtifact(controller, host.id, about, toDir)).equals(bytes)).toBe(true)
  expect(script.gets().at(-1)).toEqual({ stream: 'artifact', get: ID })
})

test('a host\'s refusal keeps its code, and a different file than the one asked for is refused', async () => {
  const { controller, script, host, toDir } = await rig()
  const bytes = randomBytes(64)
  const about = artifact(bytes)
  script.serve = () => ({ head: { type: 'refused', failure: { code: 'expired', message: 'That artifact has expired.' } } })
  await expect(fetchArtifact(controller, host.id, about, toDir)).rejects.toMatchObject({ code: 'expired', message: 'That artifact has expired.' })
  script.serve = () => ({ head: { type: 'head', artifact: { ...about, id: 'another' }, offset: 0 }, bytes })
  await expect(fetchArtifact(controller, host.id, about, toDir)).rejects.toMatchObject({ code: 'refused' })
  await expect(fetchArtifact(controller, host.id, { ...about, id: '../escape' }, toDir)).rejects.toMatchObject({ code: 'refused' })
  await expect(fetchArtifact(controller, host.id, { ...about, sha256: 'nope' }, toDir)).rejects.toMatchObject({ code: 'refused' })
  expect(script.acks()).toEqual([])
  expect(existsSync(toDir) ? readdirSync(toDir) : []).toEqual([])
})

test('a name from the host never leaves the folder or replaces a file that is there', async () => {
  const { controller, script, host, toDir, dir } = await rig()
  const bytes = randomBytes(32)
  const about = artifact(bytes, { name: join('..', '..', 'render.png') })
  script.serve = whole(bytes, about)
  const first = await fetchArtifact(controller, host.id, about, toDir)
  expect(dirname(first)).toBe(toDir)
  const second = await fetchArtifact(controller, host.id, about, toDir)
  expect(dirname(second)).toBe(toDir)
  expect(second).not.toBe(first)
  expect(readFileSync(first).equals(bytes) && readFileSync(second).equals(bytes)).toBe(true)
  expect(readdirSync(dir)).toEqual(['home'])
  script.serve = whole(bytes, { ...about, name: '..' })
  expect(await fetchArtifact(controller, host.id, { ...about, name: '..' }, toDir)).toBe(join(toDir, ID))
})

test('an upload states the size and hash first, streams the bytes, and returns what the host stored', async () => {
  const { controller, script, host, dir } = await rig()
  const bytes = randomBytes(300 * 1024)
  const path = join(dir, 'input.wav')
  writeFileSync(path, bytes)
  const stored = await upload(controller, host.id, 'job-1', { path, name: 'voice.wav', mime: 'audio/wav' })
  expect(stored).toEqual({ id: ID, jobId: 'job-1', name: 'voice.wav', mime: 'audio/wav', bytes: bytes.length, sha256: sha256(bytes), expiresAt: 9e12 })
  expect(script.received).toHaveLength(1)
  expect(script.received[0]!.put).toEqual({ jobId: 'job-1', name: 'voice.wav', mime: 'audio/wav', bytes: bytes.length, sha256: sha256(bytes) })
  expect(script.received[0]!.bytes.equals(bytes)).toBe(true)
  // No path crosses: the host is told a display name, never where the file was.
  expect(JSON.stringify(script.opened.map((one) => one.open))).not.toContain(dir)
})

test('an upload the host refuses, or does not confirm, is an error with the host\'s reason', async () => {
  const { controller, script, host, dir } = await rig()
  const path = join(dir, 'input.bin')
  writeFileSync(path, randomBytes(2048))
  script.store = () => ({ type: 'refused', failure: { code: 'refused', message: 'The input size or checksum does not match.' } })
  await expect(upload(controller, host.id, 'job-1', { path, name: 'input.bin', mime: 'application/octet-stream' })).rejects.toMatchObject({ code: 'refused', message: 'The input size or checksum does not match.' })
  script.store = (put) => ({ type: 'stored', artifact: { id: ID, jobId: put.jobId, name: put.name, mime: put.mime, bytes: put.bytes, sha256: '0'.repeat(64), expiresAt: 1 } })
  await expect(upload(controller, host.id, 'job-1', { path, name: 'input.bin', mime: 'application/octet-stream' })).rejects.toBeInstanceOf(ComputeError)
  await expect(upload(controller, host.id, 'job-1', { path: join(dir, 'missing'), name: 'missing', mime: 'text/plain' })).rejects.toMatchObject({ code: 'refused' })
  expect(script.received).toHaveLength(2)
})
