// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, request, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { Duplex, type Readable, type Writable } from 'node:stream'
import { isStreamKind, STREAM_KINDS, type StreamKind } from './protocol.js'
import { ComputeError, PAIRING_CODE_MS, type ConnectionState, type Role } from './types.js'

export interface ConnectOptions {
  dataDir: string
  role: Role
  allow: readonly string[]
  services?: { relay?: string; mailbox?: string }
  binary?: string
  log?(line: string): void
}

export interface PairedPeer { endpointId: string; name: string; role: Role; platform: string; appVersion: string }
export interface Connect {
  identity(): Promise<string>
  allow(endpointIds: readonly string[]): Promise<void>
  open(endpointId: string, kind: StreamKind, signal?: AbortSignal): Promise<Duplex>
  accept(handler: (stream: Duplex, from: { endpointId: string; kind: StreamKind }) => void): void
  state(endpointId: string): ConnectionState
  onState(listener: (endpointId: string, state: ConnectionState) => void): () => void
  pairOpen(me: Omit<PairedPeer, 'endpointId'>, signal: AbortSignal): Promise<{ code: string; expiresAt: number; done: Promise<PairedPeer> }>
  pairJoin(code: string, me: Omit<PairedPeer, 'endpointId'>, signal: AbortSignal): Promise<PairedPeer>
  close(): Promise<void>
}

export interface ConnectHints { relayUrl?: string | null; directAddresses?: readonly string[] }

const endpointId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const windowBytes = 64 * 1024
const pathFor = (kind: StreamKind): string => `/v1/streams/${kind}`
const interrupted = (): ComputeError => new ComputeError('interrupted', 'The compute stream was reset.')
const offline = (): ComputeError => new ComputeError('offline', 'The compute connection is offline.')
const cancelled = (): ComputeError => new ComputeError('cancelled', 'The compute request was cancelled.')
const refused = (): ComputeError => new ComputeError('refused', 'The compute request was refused.')
const unpaired = (): ComputeError => new ComputeError('unpaired', 'That computer is not paired.')

function validateAllow(ids: readonly string[]): void {
  if (ids.length > 64 || !ids.every(endpointId)) throw refused()
}

function wireError(code: string): ComputeError {
  if (code === 'peer_not_allowed' || code === 'peer_rejected') return unpaired()
  if (code === 'peer_unreachable' || code === 'network_failed') return offline()
  if (code === 'host_unavailable') return new ComputeError('setup-required', 'The compute service is unavailable.')
  if (code === 'stream_failed') return interrupted()
  if (code === 'pairing_expired') return new ComputeError('expired', 'The pairing code expired.')
  if (code === 'pairing_cancelled') return cancelled()
  if (code === 'mailbox_not_configured') return new ComputeError('setup-required', 'The pairing mailbox is not configured.')
  return refused()
}

type PairingMe = Omit<PairedPeer, 'endpointId'>
interface PairingTicket { pairingId: string; expiresAt: number; code?: string }
interface PairingResult {
  state: 'waiting' | 'paired' | 'failed'
  error?: { code: string }
  peer?: { endpointId: string; name: string; payload: { role: Role; platform: string; appVersion: string }; hints: ConnectHints }
}

function pairingBody(me: PairingMe): { name: string; payload: Omit<PairingMe, 'name'>; exclusive: boolean } {
  if (typeof me.name !== 'string' || Buffer.byteLength(me.name) < 1 || Buffer.byteLength(me.name) > 128 || [...me.name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    !['interaction', 'compute'].includes(me.role) || typeof me.platform !== 'string' || typeof me.appVersion !== 'string') throw refused()
  const payload = { role: me.role, platform: me.platform, appVersion: me.appVersion }
  if (Buffer.byteLength(JSON.stringify(payload)) > 1024) throw refused()
  return { name: me.name, payload, exclusive: me.role === 'compute' }
}

function provenPeer(result: PairingResult): PairedPeer {
  if (result.state === 'failed') throw wireError(result.error?.code ?? '')
  const peer = result.peer
  if (result.state !== 'paired' || !peer || !endpointId(peer.endpointId) || !peer.payload) throw refused()
  const me = { name: peer.name, role: peer.payload.role, platform: peer.payload.platform, appVersion: peer.payload.appVersion }
  pairingBody(me)
  return { endpointId: peer.endpointId, ...me }
}

/** No discovery or spawn happens at import time. */
export function binaryPath(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string | undefined {
  const candidate = env.ALEXIA_CONNECT_BIN ?? join(dirname(execPath), process.platform === 'win32' ? 'alexia-connect.exe' : 'alexia-connect')
  return existsSync(candidate) ? candidate : undefined
}

abstract class Connection implements Connect {
  protected allowed = new Set<string>()
  protected closed = false
  protected handler?: Parameters<Connect['accept']>[0]
  protected streams = new Map<Duplex, string>()
  private states = new Map<string, ConnectionState>()
  private listeners = new Set<Parameters<Connect['onState']>[0]>()

  abstract identity(): Promise<string>
  abstract allow(ids: readonly string[]): Promise<void>
  abstract open(id: string, kind: StreamKind, signal?: AbortSignal): Promise<Duplex>
  abstract close(): Promise<void>
  abstract pairOpen(me: Omit<PairedPeer, 'endpointId'>, signal: AbortSignal): Promise<{ code: string; expiresAt: number; done: Promise<PairedPeer> }>
  abstract pairJoin(code: string, me: Omit<PairedPeer, 'endpointId'>, signal: AbortSignal): Promise<PairedPeer>
  abstract hints(id: string, hints: ConnectHints): Promise<void>
  abstract ownHints(id?: string): Promise<ConnectHints>

  accept(handler: Parameters<Connect['accept']>[0]): void { this.handler = handler }
  state(id: string): ConnectionState { return this.states.get(id) ?? 'offline' }
  onState(listener: Parameters<Connect['onState']>[0]): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  protected change(id: string, state: ConnectionState): void {
    if (this.state(id) === state) return
    this.states.set(id, state)
    for (const listener of this.listeners) listener(id, state)
  }

  protected replaceAllow(ids: readonly string[]): void {
    this.allowed = new Set(ids)
    for (const [stream, id] of this.streams) if (!this.allowed.has(id)) stream.destroy(unpaired())
    for (const id of this.states.keys()) if (!this.allowed.has(id)) { this.change(id, 'offline'); this.states.delete(id) }
  }

  protected check(id: string, kind: StreamKind, signal?: AbortSignal): void {
    if (this.closed) throw offline()
    if (signal?.aborted) throw cancelled()
    if (!isStreamKind(kind)) throw refused()
    if (!this.allowed.has(id)) throw unpaired()
  }

  protected track(stream: Duplex, id: string, signal?: AbortSignal): Duplex {
    this.streams.set(stream, id)
    // A reset may arrive before the caller attaches its own observer. Keep it an error,
    // without turning an unobserved transport event into an uncaught process exception.
    stream.on('error', () => {})
    const abort = () => { stream.destroy(cancelled()) }
    signal?.addEventListener('abort', abort, { once: true })
    stream.once('close', () => {
      this.streams.delete(stream)
      signal?.removeEventListener('abort', abort)
    })
    if (signal?.aborted) abort()
    return stream
  }

  protected stop(error: ComputeError): void {
    this.closed = true
    for (const stream of this.streams.keys()) stream.destroy(error)
    for (const id of this.allowed) this.change(id, 'offline')
    this.listeners.clear()
  }
}

/** Address hints locate an already trusted identity; they never add it to the allowlist. */
export async function setPeerHints(client: Connect, id: string, hints: ConnectHints): Promise<void> {
  if (!(client instanceof Connection)) throw refused()
  await client.hints(id, hints)
}

/** Own addresses, or a proven peer's cached hints for core to persist with its record. */
export async function readConnectHints(client: Connect, id?: string): Promise<ConnectHints> {
  if (!(client instanceof Connection)) throw refused()
  return client.ownHints(id)
}

class HttpStream extends Duplex {
  constructor(private input: Readable, private output: Writable, private dispose: () => void) {
    super({ highWaterMark: windowBytes, allowHalfOpen: true })
    input.pause()
    input.on('data', (chunk: Buffer) => { if (!this.push(chunk)) input.pause() })
    input.once('end', () => { this.push(null) })
    input.once('error', () => { this.destroy(interrupted()) })
    // **A response that has arrived whole is not a reset**, whether or not it has all been read. The host ends a job's
    // stream after its last frame, and Node then closes the request too — which this side has not ended, because it
    // keeps it open for a *cancel*. Treating that close as a failure destroyed the stream with the final `done` frame
    // still unread, and a render that had finished came back as *the compute stream was reset*.
    const whole = (): boolean => (input as Partial<IncomingMessage>).complete === true
    input.once('close', () => { if (!input.readableEnded && !whole()) this.destroy(interrupted()) })
    output.once('error', () => { this.destroy(interrupted()) })
    output.once('close', () => { if (!output.writableFinished && !whole()) this.destroy(interrupted()) })
  }

  override _read(): void { this.input.resume() }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.output.write(chunk, done)
  }
  override _final(done: (error?: Error | null) => void): void { this.output.end(done) }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.dispose()
    done(error)
  }
}

interface Ready { ready: true; protocol: number; port: number; endpointId: string }

async function readiness(child: ChildProcessWithoutNullStreams): Promise<Ready> {
  return new Promise((resolveReady, reject) => {
    let buffered = ''
    const timeout = setTimeout(() => fail(), 20_000)
    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout.removeListener('data', data)
      child.removeListener('error', fail)
      child.removeListener('exit', fail)
    }
    const fail = () => {
      cleanup()
      reject(new ComputeError('setup-required', 'The compute transport could not start.'))
    }
    const data = (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      if (Buffer.byteLength(buffered) > windowBytes) { fail(); return }
      const newline = buffered.indexOf('\n')
      if (newline === -1) return
      try {
        const value: Partial<Ready> = JSON.parse(buffered.slice(0, newline))
        if (value.ready !== true || !endpointId(value.endpointId) || !Number.isInteger(value.port) || value.port! < 1 || value.port! > 65535) { fail(); return }
        cleanup()
        if (value.protocol !== 1) { reject(new ComputeError('incompatible-version', 'The compute transport version is incompatible.')); return }
        resolveReady(value as Ready)
      } catch { fail() }
    }
    child.stdout.on('data', data)
    child.once('error', fail)
    child.once('exit', fail)
  })
}

async function jsonBody(response: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of response) {
    const bytes = chunk as Buffer
    length += bytes.length
    if (length > windowBytes) { response.destroy(); throw refused() }
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw interrupted() }
}

class NativeConnection extends Connection {
  private host?: Server
  private events?: ClientRequest
  private closing?: Promise<void>
  private learnedHints = new Map<string, ConnectHints>()

  constructor(private child: ChildProcessWithoutNullStreams, private ready: Ready, private secret: string, private options: ConnectOptions) {
    super()
    child.once('exit', () => { this.stop(offline()); this.events?.destroy(); this.host?.closeAllConnections(); this.host?.close() })
    child.on('error', () => { this.stop(offline()) })
    child.stdin.on('error', () => {})
  }

  async identity(): Promise<string> { return this.ready.endpointId }

  async call<T>(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    if (this.closed) throw offline()
    const encoded = body === undefined ? undefined : JSON.stringify(body)
    if (encoded && Buffer.byteLength(encoded) > windowBytes) throw refused()
    return new Promise<T>((resolveCall, reject) => {
      const req = request({ hostname: '127.0.0.1', port: this.ready.port, method, path, agent: false,
        headers: { authorization: `Bearer ${this.secret}`, ...(encoded !== undefined && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }) } }, (res) => {
        void jsonBody(res).then((value) => {
          const error = res.headers['x-alexia-connect-error']
          if (error) reject(wireError(String(error)))
          else if (res.statusCode !== 200) reject(refused())
          else resolveCall(value as T)
        }, reject)
      })
      req.setTimeout(timeoutMs, () => { req.destroy(offline()) })
      req.once('error', () => { reject(offline()) })
      req.end(encoded)
    })
  }

  async start(): Promise<void> {
    await this.allow(this.options.allow)
    this.host = createServer((req, res) => { this.incoming(req, res) })
    await new Promise<void>((resolveHost, reject) => {
      this.host!.once('error', reject)
      this.host!.listen(0, '127.0.0.1', resolveHost)
    })
    const address = this.host.address()
    if (!address || typeof address === 'string') throw offline()
    await this.call('PUT', '/v1/host', { port: address.port, secret: this.secret,
      operations: STREAM_KINDS.map((kind) => ({ name: kind, method: 'POST', path: pathFor(kind) })) })
    await this.subscribe()
    this.options.log?.('Compute transport ready.')
  }

  private incoming(req: IncomingMessage, res: ServerResponse): void {
    const id = req.headers['x-alexia-peer']
    const kind = STREAM_KINDS.find((item) => req.url === pathFor(item))
    if (req.headers.authorization !== `Bearer ${this.secret}` || req.headers.host !== `127.0.0.1:${(this.host!.address() as { port: number }).port}` || !endpointId(id) || !this.allowed.has(id)) {
      res.writeHead(403).end(); return
    }
    if (req.method !== 'POST' || !kind || !this.handler || this.closed) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.flushHeaders()
    const stream = this.track(new HttpStream(req, res, () => { req.destroy(); res.destroy() }), id)
    try { this.handler(stream, { endpointId: id, kind }) }
    catch { stream.destroy(interrupted()) }
  }

  async allow(ids: readonly string[]): Promise<void> {
    validateAllow(ids)
    await this.call('PUT', '/v1/allowlist', { endpointIds: ids })
    this.replaceAllow(ids)
    for (const [id, hints] of this.learnedHints) {
      if (this.allowed.has(id)) await this.hints(id, hints)
      else this.learnedHints.delete(id)
    }
  }

  async hints(id: string, hints: ConnectHints): Promise<void> {
    if (!this.allowed.has(id)) throw unpaired()
    await this.call('PUT', `/v1/peers/${id}/hints`, hints)
    this.learnedHints.set(id, structuredClone(hints))
  }

  async ownHints(id?: string): Promise<ConnectHints> {
    if (id !== undefined) {
      const hints = this.learnedHints.get(id)
      if (!hints) throw new ComputeError('not-found', 'No connection hints are available for that computer.')
      return structuredClone(hints)
    }
    const status = await this.call<{ relayUrl: string | null; directAddresses: string[] }>('GET', '/v1/status')
    return { relayUrl: status.relayUrl, directAddresses: status.directAddresses }
  }

  async open(id: string, kind: StreamKind, signal?: AbortSignal): Promise<Duplex> {
    this.check(id, kind, signal)
    return new Promise<Duplex>((resolveStream, reject) => {
      const abort = () => { req.destroy(cancelled()); reject(cancelled()) }
      const req = request({ hostname: '127.0.0.1', port: this.ready.port, path: `/bridge/${id}${pathFor(kind)}`, method: 'POST', agent: false,
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } }, (res) => {
        signal?.removeEventListener('abort', abort)
        req.setTimeout(0)
        const error = res.headers['x-alexia-connect-error']
        if (error || res.statusCode !== 200) {
          res.resume(); req.end(); reject(error ? wireError(String(error)) : refused()); return
        }
        if (this.closed || !this.allowed.has(id) || signal?.aborted) {
          req.destroy(); res.destroy(); reject(signal?.aborted ? cancelled() : this.closed ? offline() : unpaired()); return
        }
        resolveStream(this.track(new HttpStream(res, req, () => { req.destroy(); res.destroy() }), id, signal))
      })
      req.setTimeout(20_000, () => { req.destroy(offline()) })
      req.on('error', () => { signal?.removeEventListener('abort', abort); reject(signal?.aborted ? cancelled() : offline()) })
      req.once('close', () => { signal?.removeEventListener('abort', abort) })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      else req.flushHeaders()
    })
  }

  private async subscribe(): Promise<void> {
    await new Promise<void>((resolveEvents, reject) => {
      let received = false
      const req = request({ hostname: '127.0.0.1', port: this.ready.port, path: '/v1/events', agent: false,
        headers: { authorization: `Bearer ${this.secret}` } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(refused()); return }
        let buffered = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buffered += chunk
          if (Buffer.byteLength(buffered) > windowBytes) { req.destroy(); return }
          let boundary: number
          while ((boundary = buffered.indexOf('\n\n')) !== -1) {
            const frame = buffered.slice(0, boundary)
            buffered = buffered.slice(boundary + 2)
            const event = frame.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim()
            const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
            if (!data) continue
            try {
              const value = JSON.parse(data) as { peers?: { endpointId: string; status: ConnectionState }[]; endpointId?: string; status?: ConnectionState }
              if (event === 'snapshot' && Array.isArray(value.peers)) {
                for (const id of this.allowed) this.change(id, value.peers.find((peer) => peer.endpointId === id)?.status ?? 'offline')
                received = true
                req.setTimeout(0)
                resolveEvents()
              } else if (event === 'peer' && endpointId(value.endpointId) && ['direct', 'relayed', 'offline'].includes(value.status ?? '')) {
                if (this.allowed.has(value.endpointId) || value.status === 'offline') this.change(value.endpointId, value.status!)
              }
            } catch { req.destroy() }
          }
        })
        const lost = () => {
          for (const id of this.allowed) this.change(id, 'offline')
          if (!received) reject(offline())
        }
        res.once('error', lost)
        res.once('end', lost)
      })
      this.events = req
      req.setTimeout(20_000, () => { req.destroy() })
      req.on('error', () => { reject(offline()) })
      req.end()
    })
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }

  private async shutdown(): Promise<void> {
    this.stop(offline())
    this.events?.destroy()
    this.host?.closeAllConnections()
    const hostClosed = new Promise<void>((done) => { if (this.host?.listening) this.host.close(() => done()); else done() })
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise<void>((done) => {
        const timer = setTimeout(() => { this.child.kill('SIGKILL') }, 2000)
        this.child.once('exit', () => { clearTimeout(timer); done() })
        this.child.stdin.end()
      })
    }
    await hostClosed
    this.secret = ''
  }

  private async pairingStart(path: 'host' | 'join', me: PairingMe, signal: AbortSignal, code?: string): Promise<PairingTicket> {
    if (signal.aborted) throw cancelled()
    const ticket = await this.call<PairingTicket>('POST', `/v1/pairing/${path}`, { ...pairingBody(me), exclusive: this.options.role === 'compute', ...(code !== undefined && { code }) })
    if (!/^[a-f0-9]{16}$/.test(ticket.pairingId) || !Number.isFinite(ticket.expiresAt)) throw refused()
    if (signal.aborted) {
      await this.call('DELETE', `/v1/pairing/${ticket.pairingId}`)
      throw cancelled()
    }
    return ticket
  }

  private async pairingWait(ticket: PairingTicket, signal: AbortSignal): Promise<PairedPeer> {
    const path = `/v1/pairing/${ticket.pairingId}`
    const abort = () => { void this.call('DELETE', path).catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      const result = await this.call<PairingResult>('GET', `${path}?wait=true`, undefined, Math.max(1000, ticket.expiresAt - Date.now() + 1000))
      if (signal.aborted) throw cancelled()
      const peer = provenPeer(result)
      // Core still decides whether to trust it. Only a later allow() installs these hints.
      this.learnedHints.set(peer.endpointId, result.peer!.hints)
      return peer
    } catch (error) {
      if (signal.aborted || this.closed) throw cancelled()
      if (error instanceof ComputeError && ['expired', 'cancelled', 'refused'].includes(error.code)) throw error
      throw refused()
    } finally { signal.removeEventListener('abort', abort) }
  }

  async pairOpen(me: PairingMe, signal: AbortSignal): Promise<{ code: string; expiresAt: number; done: Promise<PairedPeer> }> {
    const ticket = await this.pairingStart('host', me, signal)
    if (typeof ticket.code !== 'string') throw refused()
    const done = this.pairingWait(ticket, signal)
    void done.catch(() => {})
    return { code: ticket.code, expiresAt: ticket.expiresAt, done }
  }

  async pairJoin(code: string, me: PairingMe, signal: AbortSignal): Promise<PairedPeer> {
    return this.pairingWait(await this.pairingStart('join', me, signal, code), signal)
  }
}

/** Launch the transport lazily; absence is a catchable feature-availability failure. */
export async function connect(options: ConnectOptions): Promise<Connect> {
  validateAllow(options.allow)
  const binary = options.binary ?? binaryPath()
  if (!binary || !existsSync(binary)) throw new ComputeError('setup-required', 'The compute transport is not installed.')
  const secret = randomBytes(32).toString('hex')
  const env = { ...process.env }
  delete env.ALEXIA_CONNECT_SECRET
  env.ALEXIA_CONNECT_KEYCHAIN = `${env.ALEXIA_CONNECT_KEYCHAIN ?? 'dev.alexia.connect'}.${createHash('sha256').update(resolve(options.dataDir)).digest('hex').slice(0, 24)}`
  if (options.services?.relay !== undefined) env.ALEXIA_CONNECT_RELAY_URLS = options.services.relay
  if (options.services?.mailbox !== undefined) env.ALEXIA_CONNECT_MAILBOX_URL = options.services.mailbox
  const child = spawn(binary, [], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  // Native stderr is deliberately drained, never forwarded: this boundary must remain
  // safe even if a dependency begins printing a header or a pairing message.
  child.stderr.resume()
  child.stdin.on('error', () => {})
  const ready = readiness(child)
  child.stdin.write(`${secret}\n`)
  let client: NativeConnection | undefined
  try {
    client = new NativeConnection(child, await ready, secret, options)
    await client.start()
    return client
  } catch (error) {
    if (client) await client.close()
    else { child.stdin.end(); child.kill() }
    throw error
  }
}

class MemoryStream extends Duplex {
  peer?: MemoryStream
  private waiting?: (error?: Error | null) => void

  constructor() { super({ highWaterMark: windowBytes, allowHalfOpen: true }) }
  override _read(): void { const done = this.waiting; this.waiting = undefined; done?.() }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (!this.peer || this.peer.destroyed) { done(interrupted()); return }
    if (this.peer.push(Buffer.from(chunk))) done()
    else this.peer.waiting = done
  }
  override _final(done: (error?: Error | null) => void): void { this.peer?.push(null); done() }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    const waiting = this.waiting
    this.waiting = undefined
    waiting?.(error ?? interrupted())
    if (this.peer && !this.peer.destroyed && !(this.readableEnded && this.writableFinished)) this.peer.destroy(error ?? interrupted())
    done(error)
  }
}

class MemoryConnection extends Connection {
  peer!: MemoryConnection
  private id = randomBytes(32).toString('hex')
  private pairings = new Map<string, { me: PairingMe; finish(peer?: PairedPeer, error?: ComputeError): void }>()

  async identity(): Promise<string> { return this.id }
  async ownHints(id?: string): Promise<ConnectHints> {
    if (id !== undefined && id !== this.peer.id) throw new ComputeError('not-found', 'No connection hints are available for that computer.')
    return { relayUrl: null, directAddresses: [] }
  }
  async hints(id: string, hints: ConnectHints): Promise<void> {
    if (!this.allowed.has(id)) throw unpaired()
    if (hints.directAddresses && hints.directAddresses.length > 16) throw refused()
  }
  async allow(ids: readonly string[]): Promise<void> {
    if (this.closed) throw offline()
    validateAllow(ids)
    this.replaceAllow(ids)
    if (!this.allowed.has(this.peer.id)) this.peer.change(this.id, 'offline')
  }
  async open(id: string, kind: StreamKind, signal?: AbortSignal): Promise<Duplex> {
    this.check(id, kind, signal)
    if (id !== this.peer.id || this.peer.closed) throw offline()
    if (!this.peer.allowed.has(this.id)) throw unpaired()
    if (!this.peer.handler) throw refused()
    const a = new MemoryStream(), b = new MemoryStream()
    a.peer = b; b.peer = a
    this.track(a, id, signal)
    this.peer.track(b, this.id)
    this.change(id, 'direct')
    this.peer.change(this.id, 'direct')
    try { this.peer.handler(b, { endpointId: this.id, kind }) }
    catch { b.destroy(interrupted()) }
    return a
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.stop(offline())
    for (const pairing of this.pairings.values()) pairing.finish(undefined, cancelled())
    this.peer.change(this.id, 'offline')
  }

  async pairOpen(me: PairingMe, signal: AbortSignal): Promise<{ code: string; expiresAt: number; done: Promise<PairedPeer> }> {
    if (this.closed) throw offline()
    if (signal.aborted) throw cancelled()
    const { name, payload } = pairingBody(me)
    if (me.role === 'compute' && this.allowed.size) throw refused()
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa']
    const random = randomBytes(8)
    const code = `${random.readUInt32BE(0)}-${[...random.subarray(4)].map((byte) => words[byte % words.length]).join('-')}`
    const expiresAt = Date.now() + PAIRING_CODE_MS
    let finish!: (peer?: PairedPeer, error?: ComputeError) => void
    const done = new Promise<PairedPeer>((resolvePair, reject) => {
      const abort = () => { finish(undefined, cancelled()) }
      const timer = setTimeout(() => { finish(undefined, new ComputeError('expired', 'The pairing code expired.')) }, PAIRING_CODE_MS)
      timer.unref()
      finish = (peer, error) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.pairings.delete(code)
        if (error) reject(error)
        else if (peer) resolvePair(peer)
      }
      signal.addEventListener('abort', abort, { once: true })
    })
    this.pairings.set(code, { me: { name, ...payload }, finish })
    void done.catch(() => {})
    return { code, expiresAt, done }
  }

  async pairJoin(code: string, me: PairingMe, signal: AbortSignal): Promise<PairedPeer> {
    if (this.closed) throw offline()
    if (signal.aborted) throw cancelled()
    const { name, payload } = pairingBody(me)
    if (me.role === 'compute' && this.allowed.size) throw refused()
    const pairing = this.peer.pairings.get(code.trim().toLowerCase())
    if (!pairing) {
      // In this two-end fixture a shaped wrong code is the host's single attempt.
      if (/^\d+(?:-[a-z]+){4}$/.test(code.trim().toLowerCase())) {
        for (const [hostCode, open] of this.peer.pairings) if (hostCode.split('-')[0] === code.split('-')[0]) open.finish(undefined, refused())
      }
      throw refused()
    }
    if (pairing.me.role === 'compute' && this.peer.allowed.size) { pairing.finish(undefined, refused()); throw refused() }
    pairing.finish({ endpointId: this.id, name, ...payload })
    return { endpointId: this.peer.id, ...pairing.me }
  }
}

export function memoryConnect(): { a: Connect; b: Connect } {
  const a = new MemoryConnection(), b = new MemoryConnection()
  a.peer = b; b.peer = a
  return { a, b }
}
