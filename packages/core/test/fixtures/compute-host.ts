// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { Readable, type Duplex } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { memoryConnect } from '../../src/compute/connect.js'
import { Controller, Frames, send } from '../../src/compute/controller.js'
import { Hosts } from '../../src/compute/hosts.js'
import { RemoteJobs } from '../../src/compute/jobs.js'
import { encodeFrame, type ControlEvent, type ControlRequest, type JobEvent, type Lease, type StreamOpen } from '../../src/compute/protocol.js'
import { ComputeError, type ArtifactRef, type HostInventory, type JobSnapshot } from '../../src/compute/types.js'
import { Store } from '../../src/store.js'

const sse = (value: unknown): string => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
export const RUNNER_SSE = Buffer.from([
  ': keep alive\n\n',
  sse({ model: 'native/model', choices: [{ delta: { reasoning_content: 'Think carefully.' } }] }),
  sse({ choices: [{ delta: { content: 'Hello, ' } }] }),
  sse({ choices: [{ delta: { content: '世界', tool_calls: [{ index: 0, id: 'call-1', function: { name: 'inspect', arguments: '{"name":' } }] } }] }),
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: 'tool_calls' }] }),
  sse({ usage: { prompt_tokens: 31, completion_tokens: 17 }, choices: [] }),
  sse('[DONE]'),
].join(''))

/** A runner's HTTP/SSE surface, shared by direct chat() and the scripted infer host. */
export async function stubRunner() {
  const received: Buffer[] = []
  const headers: (string | undefined)[] = []
  let aborted = 0
  const runner = {
    respond: (_body: Buffer, response: ServerResponse): void => { response.end(RUNNER_SSE) },
    received, headers,
    get aborted() { return aborted },
  }
  const server = createServer(async (request, response) => {
    response.once('close', () => { if (!response.writableFinished) ++aborted })
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    received.push(body)
    headers.push(request.headers.authorization)
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    runner.respond(body, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No runner address.')
  return { received, headers, get aborted() { return aborted },
    get respond() { return runner.respond }, set respond(fn: typeof runner.respond) { runner.respond = fn },
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}

export const testInventory = (): HostInventory => ({
  name: 'Studio', appVersion: '1.0.0', revision: 1,
  machine: { platform: 'win32', arch: 'x64', chip: 'Test', appleSilicon: false, ramBytes: 64, freeDiskBytes: 64, budgetBytes: 32 },
  models: [{ id: 'native/model', name: 'Native model', engine: 'runner', context: 8192, supportsTools: true, modality: ['text', 'image'], loaded: false }],
  capabilities: [{ cap: 'demo.render', summary: 'Render', weight: 'heavy', ready: true }], setup: [],
})

type InferOpen = Extract<StreamOpen, { stream: 'infer' }>
type JobOpen = Extract<StreamOpen, { stream: 'job'; submit: unknown }>
export interface Opened { open: StreamOpen; stream: Duplex; frames: Frames }

/** The host-protocol stand-in. Later integration tests can replace this with HostProtocol. */
export class ScriptedComputeHost {
  readonly opened: Opened[] = []
  readonly requests: ControlRequest[] = []
  readonly leases = new Map<string, Lease>()
  readonly artifacts = new Map<string, { artifact: ArtifactRef; bytes: Buffer }>()
  readonly errors: unknown[] = []
  inventory = testInventory()
  control?: Duplex
  inferAborted = 0
  prepare: (request: Extract<ControlRequest, { method: 'prepare' }>) => Lease = (request) => ({
    ...request.params, phase: 'ready', message: 'Ready.',
  })
  infer?: (open: InferOpen, stream: Duplex, frames: Frames) => Promise<void>
  job: (open: JobOpen, stream: Duplex, frames: Frames) => Promise<void> = async (open, stream) => {
    this.jobEvent(stream, { type: 'done', seq: 1, job: this.snapshot(open.submit.jobId, 'succeeded') })
    stream.end()
  }

  constructor(private readonly runnerUrl?: string) {}

  async accept(stream: Duplex): Promise<void> {
    const frames = new Frames(stream)
    try {
      const open = await frames.next() as StreamOpen
      this.opened.push({ open, stream, frames })
      if (open.stream === 'control') await this.session(stream, frames)
      else if (open.stream === 'infer') {
        if (this.infer) await this.infer(open, stream, frames)
        else await this.answer(open, stream, frames)
      } else if (open.stream === 'artifact') await this.artifact(open, stream, frames)
      else if ('submit' in open) await this.job(open, stream, frames)
      else stream.end()
    } catch (error) { if (!stream.destroyed) { this.errors.push(error); stream.destroy() } }
  }

  say(event: ControlEvent): void { this.control!.write(encodeFrame(event)) }
  jobEvent(stream: Duplex, event: JobEvent): void { stream.write(encodeFrame(event)) }
  snapshot(id: string, state: JobSnapshot['state'], artifacts?: ArtifactRef[]): JobSnapshot {
    return { id, state, kind: 'operation', weight: 'heavy', label: 'demo.render', createdAt: 1, ...(artifacts && { artifacts }) }
  }
  output(jobId: string, bytes: Buffer, name = 'output.bin'): ArtifactRef {
    const artifact: ArtifactRef = { id: randomUUID(), jobId, name, mime: 'application/octet-stream', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), expiresAt: Date.now() + 60_000 }
    this.artifacts.set(artifact.id, { artifact, bytes })
    return artifact
  }

  private async session(stream: Duplex, frames: Frames): Promise<void> {
    this.control = stream
    await send(stream, encodeFrame({ type: 'welcome', welcome: { protocol: 1, name: this.inventory.name, appVersion: '1.0.0',
      inventory: this.inventory, queue: { waiting: [], paused: false }, jobs: [] } }))
    for (;;) {
      const request = await frames.next() as ControlRequest | undefined
      if (!request) return
      this.requests.push(request)
      let result: unknown = {}
      try {
        if (request.method === 'prepare') {
          result = this.prepare(request)
          this.leases.set(request.params.leaseId, result as Lease)
        } else if (request.method === 'release') this.leases.delete(request.params.leaseId)
        else if (request.method === 'artifact.ack') for (const id of request.params.artifactIds) this.artifacts.delete(id)
        else if (request.method === 'inventory.get') result = this.inventory
        stream.write(encodeFrame({ id: request.id, ok: true, result }))
      } catch (error) { stream.write(encodeFrame({ id: request.id, ok: false, failure: (error as ComputeError).failure() })) }
    }
  }

  private async answer(open: InferOpen, stream: Duplex, frames: Frames): Promise<void> {
    if (!this.runnerUrl) throw new Error('No scripted runner configured.')
    const abort = new AbortController()
    const gone = (): void => {
      if (!stream.writableFinished) { ++this.inferAborted; abort.abort() }
    }
    stream.once('close', gone)
    try {
      const chunks: Buffer[] = []
      for await (const chunk of frames.bytes()) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      if (body.length !== open.bodyBytes) throw new Error('Infer body size changed.')
      const response = await fetch(`${this.runnerUrl}/chat/completions`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer runner-key' }, body, signal: abort.signal })
      await send(stream, encodeFrame({ type: 'head', status: response.status, contentType: response.headers.get('content-type') }))
      await pipeline(Readable.fromWeb(response.body!), stream, { signal: abort.signal })
    } finally { stream.off('close', gone) }
  }

  private async artifact(open: Extract<StreamOpen, { stream: 'artifact' }>, stream: Duplex, frames: Frames): Promise<void> {
    if ('put' in open) {
      const chunks: Buffer[] = []
      for await (const chunk of frames.bytes()) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      const artifact = this.output(open.put.jobId, bytes, open.put.name)
      artifact.mime = open.put.mime
      stream.end(encodeFrame({ type: 'stored', artifact }))
    } else {
      const found = this.artifacts.get(open.get)
      if (!found) { stream.end(encodeFrame({ type: 'refused', failure: { code: 'not-found', message: 'No artifact.' } })); return }
      await send(stream, encodeFrame({ type: 'head', artifact: found.artifact, offset: open.offset ?? 0 }))
      stream.end(found.bytes.subarray(open.offset ?? 0))
    }
  }
}

export async function computeRig(runnerUrl?: string) {
  const store = new Store(':memory:')
  const { a, b } = memoryConnect()
  await a.allow([await b.identity()])
  await b.allow([await a.identity()])
  const hosts = new Hosts(store, 'interaction')
  const host = hosts.add({ name: 'Studio', endpointId: await b.identity(), peerRole: 'compute' })
  const script = new ScriptedComputeHost(runnerUrl)
  b.accept((stream) => { void script.accept(stream) })
  const controller: Controller = new Controller({ connect: a, hosts, name: 'Laptop', appVersion: '1.0.0', resume: (hostId) => jobs.outstanding(hostId) })
  const jobs = new RemoteJobs({ controller, store })
  return { store, a, b, hosts, host, script, controller, jobs,
    close: async () => { await controller.close(); await a.close(); await b.close(); store.close() },
  }
}
