// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { binaryPath, connect, memoryConnect, readConnectHints, setPeerHints, type Connect } from '../src/compute/connect.js'
import { STREAM_KINDS, type StreamKind } from '../src/compute/protocol.js'
import { ComputeError } from '../src/compute/types.js'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn((...args: Parameters<typeof spawn>) => {
    const child = actual.spawn(...args)
    if (child.stdin) vi.spyOn(child.stdin, 'write')
    if (child.stdout) vi.spyOn(child.stdout, 'emit')
    return child
  }) }
})

const binary = process.env.ALEXIA_CONNECT_TEST_BIN ?? join(import.meta.dirname, '..', '..', '..', 'connect', 'target', 'debug', process.platform === 'win32' ? 'alexia-connect.exe' : 'alexia-connect')
if (!existsSync(binary)) process.stderr.write('Skipping real alexia-connect tests: the debug sidecar binary is absent; build it with ~/.cargo/bin/cargo build --manifest-path connect/Cargo.toml.\n')
const cleanup: (() => Promise<void>)[] = []
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})

async function fixture(native: boolean, paired = true) {
  let a: Connect, b: Connect
  if (native) {
    vi.stubEnv('ALEXIA_CONNECT_EPHEMERAL_KEY', '1')
    vi.stubEnv('ALEXIA_CONNECT_RELAY_URLS', '')
    vi.stubEnv('ALEXIA_CONNECT_LOOKUP_URL', '')
    vi.stubEnv('ALEXIA_CONNECT_MAILBOX_URL', '')
    const dir = mkdtempSync(join(tmpdir(), 'alexia-connect-test-'))
    cleanup.push(async () => { rmSync(dir, { recursive: true, force: true }) })
    a = await connect({ binary, dataDir: join(dir, 'a'), role: 'interaction', allow: [] })
    cleanup.push(() => a.close())
    b = await connect({ binary, dataDir: join(dir, 'b'), role: 'compute', allow: [] })
    cleanup.push(() => b.close())
  } else {
    ;({ a, b } = memoryConnect())
    cleanup.push(async () => { await a.close(); await b.close() })
  }
  const aId = await a.identity(), bId = await b.identity()
  if (paired) { await a.allow([bId]); await b.allow([aId]) }
  if (native && paired) {
    await setPeerHints(a, bId, await readConnectHints(b))
    await setPeerHints(b, aId, await readConnectHints(a))
  }
  return { a, b, aId, bId }
}

const hostInfo = { name: 'Compute host', role: 'compute' as const, platform: 'win32', appVersion: '1.0.0' }
const controllerInfo = { name: 'Interaction computer', role: 'interaction' as const, platform: 'darwin', appVersion: '1.0.0' }

function nativePort(child: ReturnType<typeof spawn>): number {
  const emitted = vi.mocked(child.stdout!.emit).mock.calls.find(([event]) => event === 'data')!
  return (JSON.parse((emitted[1] as Buffer).toString()) as { port: number }).port
}

describe('memory pairing', () => {
  test('single-use pairing preserves metadata but still needs both allowlists', async () => {
    const { a, b, aId, bId } = await fixture(false, false)
    const opening = await b.pairOpen(hostInfo, new AbortController().signal)
    expect(opening.code).toMatch(/^\d+(?:-[a-z]+){4}$/)
    const joined = await a.pairJoin(opening.code, controllerInfo, new AbortController().signal)
    expect(joined).toEqual({ endpointId: bId, ...hostInfo })
    expect(await opening.done).toEqual({ endpointId: aId, ...controllerInfo })
    await expect(a.open(bId, 'control')).rejects.toMatchObject({ code: 'unpaired' })
    await expect(a.pairJoin(opening.code, controllerInfo, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' })
    await b.allow([aId])
    await expect(b.pairOpen(hostInfo, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' })
  })

  test('cancellation invalidates the code and closing settles pending pairing', async () => {
    const { a, b } = await fixture(false, false)
    const abort = new AbortController()
    const opening = await b.pairOpen(hostInfo, abort.signal)
    abort.abort()
    await expect(opening.done).rejects.toMatchObject({ code: 'cancelled' })
    await expect(a.pairJoin(opening.code, controllerInfo, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' })
    const pending = await b.pairOpen(hostInfo, new AbortController().signal)
    await b.close()
    await expect(pending.done).rejects.toMatchObject({ code: 'cancelled' })
  })

  test('expiry and a shaped wrong code each consume the one attempt', async () => {
    const { a, b } = await fixture(false, false)
    vi.useFakeTimers()
    try {
      const opening = await b.pairOpen(hostInfo, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      await expect(opening.done).rejects.toMatchObject({ code: 'expired' })
      const second = await b.pairOpen(hostInfo, new AbortController().signal)
      const wrong = `${second.code.split('-')[0]}-wrong-wrong-wrong-wrong`
      await expect(a.pairJoin(wrong, controllerInfo, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' })
      await expect(second.done).rejects.toMatchObject({ code: 'refused' })
      await expect(a.pairJoin(second.code, controllerInfo, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' })
    } finally { vi.useRealTimers() }
  })
})

function accepted(client: Connect) {
  let deliver!: (value: { stream: Duplex; endpointId: string; kind: StreamKind }) => void
  const incoming = new Promise<{ stream: Duplex; endpointId: string; kind: StreamKind }>((done) => { deliver = done })
  client.accept((stream, from) => { deliver({ stream, ...from }) })
  return incoming
}

function readBytes(stream: Duplex): Promise<Buffer> {
  return (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
  })()
}

test('missing binary is a catchable unavailable state; discovery is side-effect free', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alexia-connect-absent-'))
  try {
    const missing = join(dir, 'missing')
    expect(binaryPath({ ALEXIA_CONNECT_BIN: missing }, process.execPath)).toBeUndefined()
    await expect(connect({ binary: missing, dataDir: dir, role: 'interaction', allow: [] })).rejects.toMatchObject({ code: 'setup-required' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

for (const native of [false, true]) {
  const available = !native || existsSync(binary)
  const name = native ? (available ? 'real debug sidecar' : 'real debug sidecar (skipped: connect/target/debug/alexia-connect is absent; build with cargo)') : 'memoryConnect'
  describe.runIf(available)(name, () => {
    test('both allowlists gate delivery and hints never confer trust', async () => {
      const { a, b, aId, bId } = await fixture(native)
      const handler = vi.fn()
      b.accept(handler)
      await a.allow([])
      await expect(a.open(bId, 'control')).rejects.toMatchObject({ code: 'unpaired' })
      await expect(setPeerHints(a, bId, { directAddresses: [] })).rejects.toMatchObject({ code: 'unpaired' })
      await a.allow([bId])
      await b.allow([])
      await expect(a.open(bId, 'control')).rejects.toSatisfy((error: ComputeError) => ['unpaired', 'offline'].includes(error.code))
      expect(handler).not.toHaveBeenCalled()
      await expect(a.allow(['malformed'])).rejects.toMatchObject({ code: 'refused' })
      await b.allow([aId])
    })

    test('exactly four kinds carry bytes and the authenticated sender identity', async () => {
      const { a, b, aId, bId } = await fixture(native)
      const kinds: string[] = []
      b.accept((stream, from) => {
        expect(from.endpointId).toBe(aId)
        kinds.push(from.kind)
        stream.on('data', (bytes: Buffer) => { stream.write(bytes) })
        stream.on('end', () => { stream.end() })
      })
      for (const kind of STREAM_KINDS) {
        const stream = await a.open(bId, kind)
        const output = readBytes(stream)
        stream.end(Buffer.from([0, 255, 10, ...Buffer.from(kind)]))
        expect(await output).toEqual(Buffer.from([0, 255, 10, ...Buffer.from(kind)]))
      }
      expect(kinds).toEqual(STREAM_KINDS)
      await expect(a.open(bId, 'execute' as StreamKind)).rejects.toMatchObject({ code: 'refused' })
      expect(kinds).toHaveLength(4)
    })

    test('the request stays writable after the first response byte', async () => {
      const { a, b, bId } = await fixture(native)
      const incoming = accepted(b)
      const stream = await a.open(bId, 'control')
      const peer = (await incoming).stream
      const response = once(stream, 'data')
      peer.write('ready')
      expect((await response)[0]).toEqual(Buffer.from('ready'))
      const request = once(peer, 'data')
      stream.write('after-response')
      expect((await request)[0]).toEqual(Buffer.from('after-response'))
      const secondResponse = once(stream, 'data')
      peer.write('acknowledged')
      expect((await secondResponse)[0]).toEqual(Buffer.from('acknowledged'))
      const requestEnd = once(peer, 'end')
      stream.end()
      await requestEnd
      const responseEnd = once(stream, 'end')
      peer.end()
      await responseEnd
    })

    test('a paused response reader stalls the writer, then resumes without losing bytes', async () => {
      const { a, b, bId } = await fixture(native)
      const incoming = accepted(b)
      const stream = await a.open(bId, 'artifact')
      const peer = (await incoming).stream
      stream.end()
      peer.resume()
      const chunk = Buffer.alloc(64 * 1024, 7)
      const total = 64 * 1024 * 1024
      let written = 0
      const writing = (async () => {
        while (written < total) {
          await new Promise<void>((done, reject) => { peer.write(chunk, (error) => error ? reject(error) : done()) })
          written += chunk.length
        }
        peer.end()
      })()
      // Give all bounded socket and QUIC windows time to fill, then observe the stall.
      await pause(250)
      expect(written).toBeLessThan(total)
      const stalledAt = written
      await pause(150)
      expect(written).toBe(stalledAt)
      let received = 0
      for await (const bytes of stream) {
        received += (bytes as Buffer).length
        expect((bytes as Buffer).every((byte) => byte === 7)).toBe(true)
      }
      await writing
      expect(received).toBe(total)
    })

    test('a paused request reader stalls uploads too', async () => {
      const { a, b, bId } = await fixture(native)
      const incoming = accepted(b)
      const stream = await a.open(bId, 'job')
      const peer = (await incoming).stream
      const chunk = Buffer.alloc(64 * 1024, 3), total = 64 * 1024 * 1024
      let written = 0
      const writing = (async () => {
        while (written < total) {
          await new Promise<void>((done, reject) => { stream.write(chunk, (error) => error ? reject(error) : done()) })
          written += chunk.length
        }
        stream.end()
      })()
      await pause(250)
      expect(written).toBeLessThan(total)
      const stalledAt = written
      await pause(150)
      expect(written).toBe(stalledAt)
      let received = 0
      for await (const bytes of peer) received += (bytes as Buffer).length
      await writing
      expect(received).toBe(total)
      stream.resume()
      const end = once(stream, 'end')
      peer.end()
      await end
    })

    test('a reset is an error and never a clean end', async () => {
      const { a, b, bId } = await fixture(native)
      const incoming = accepted(b)
      const stream = await a.open(bId, 'infer')
      const peer = (await incoming).stream
      const ended = vi.fn()
      stream.on('end', ended)
      stream.resume()
      const error = once(stream, 'error')
      peer.destroy(new ComputeError('interrupted', 'Test reset'))
      expect((await error)[0]).toMatchObject({ code: 'interrupted' })
      expect(ended).not.toHaveBeenCalled()
    })

    test('revocation closes live streams before allow resolves and changes state', async () => {
      const { a, b, bId } = await fixture(native)
      const incoming = accepted(b)
      const states: string[] = []
      const unsubscribe = a.onState((id, state) => { if (id === bId) states.push(state) })
      const stream = await a.open(bId, 'job')
      await incoming
      await vi.waitFor(() => { expect(a.state(bId)).toBe('direct') })
      const error = once(stream, 'error')
      await a.allow([])
      expect(stream.destroyed).toBe(true)
      expect((await error)[0]).toBeInstanceOf(ComputeError)
      expect(a.state(bId)).toBe('offline')
      expect(states).toContain('direct')
      expect(states.at(-1)).toBe('offline')
      unsubscribe()
      await expect(a.open(bId, 'job')).rejects.toMatchObject({ code: 'unpaired' })
    })

    test('abort resets the peer and never opens an already cancelled stream', async () => {
      const { a, b, bId } = await fixture(native)
      const incoming = accepted(b)
      const abort = new AbortController()
      const stream = await a.open(bId, 'infer', abort.signal)
      const peer = (await incoming).stream
      const reset = once(peer, 'error')
      abort.abort()
      expect(stream.destroyed).toBe(true)
      expect((await reset)[0]).toBeInstanceOf(ComputeError)
      await expect(a.open(bId, 'infer', abort.signal)).rejects.toMatchObject({ code: 'cancelled' })
    })

    test('a stalled artifact does not block another operation', async () => {
      const { a, b, bId } = await fixture(native)
      b.accept((stream, from) => {
        if (from.kind === 'artifact') stream.write(Buffer.alloc(64 * 1024))
        else { stream.resume(); stream.end('control-ready') }
      })
      const slow = await a.open(bId, 'artifact')
      const fast = await a.open(bId, 'control')
      const output = readBytes(fast)
      fast.end()
      expect((await output).toString()).toBe('control-ready')
      slow.destroy()
    })

    test('close is idempotent and future opens report offline', async () => {
      const { a, bId } = await fixture(native)
      await a.close(); await a.close()
      await expect(a.open(bId, 'control')).rejects.toMatchObject({ code: 'offline' })
    })

    test('pairing rejects already aborted requests before doing any work', async () => {
      const { a, b } = await fixture(native, false)
      const abort = new AbortController()
      abort.abort()
      await expect(b.pairOpen(hostInfo, abort.signal)).rejects.toMatchObject({ code: 'cancelled' })
      await expect(a.pairJoin('7-alpha-bravo-charlie-delta', controllerInfo, abort.signal)).rejects.toMatchObject({ code: 'cancelled' })
    })
  })
}

describe.runIf(existsSync(binary))(existsSync(binary) ? 'native authentication and pairing configuration' : 'native authentication (skipped: debug sidecar binary is absent)', () => {
  test('each launch uses a fresh stdin secret, authenticates all surfaces, registers only four operations, and exits cleanly', async () => {
    vi.stubEnv('ALEXIA_CONNECT_EPHEMERAL_KEY', '1')
    vi.stubEnv('ALEXIA_CONNECT_RELAY_URLS', '')
    vi.stubEnv('ALEXIA_CONNECT_LOOKUP_URL', '')
    vi.stubEnv('ALEXIA_CONNECT_SECRET', 'inherited-secret-must-not-be-used')
    const dir = mkdtempSync(join(tmpdir(), 'alexia-connect-auth-'))
    cleanup.push(async () => { rmSync(dir, { recursive: true, force: true }) })
    const logs: string[] = [], secrets: string[] = []
    for (let launch = 0; launch < 2; launch++) {
      const starting = connect({ binary, dataDir: dir, role: 'compute', allow: [], log: (line) => { logs.push(line) } })
      const child = vi.mocked(spawn).mock.results.at(-1)!.value as ReturnType<typeof spawn>
      const ready = once(child.stdout!, 'data')
      const client = await starting
      cleanup.push(() => client.close())
      const port = (JSON.parse(((await ready)[0] as Buffer).toString()) as { port: number }).port
      const call = vi.mocked(spawn).mock.calls.at(-1)!
      expect(call[1]).toEqual([])
      expect(call[2]?.env?.ALEXIA_CONNECT_SECRET === undefined).toBe(true)
      const secret = String(vi.mocked(child.stdin!.write).mock.calls[0]![0]).trim()
      expect(/^[a-f0-9]{64}$/.test(secret)).toBe(true)
      secrets.push(secret)
      const base = `http://127.0.0.1:${port}`
      for (const path of ['/v1/status', '/v1/events', `/bridge/${'a'.repeat(64)}/v1/streams/control`]) {
        expect((await fetch(`${base}${path}`)).status).toBe(401)
        expect((await fetch(`${base}${path}`, { headers: { authorization: 'Bearer incorrect' } })).status).toBe(401)
      }
      const response = await fetch(`${base}/v1/status`, { headers: { authorization: `Bearer ${secret}` } })
      const status = await response.json() as { host: { port: number; operations: { name: string; method: string; path: string }[] } }
      expect(status.host.operations).toEqual(STREAM_KINDS.map((kind) => ({ name: kind, method: 'POST', path: `/v1/streams/${kind}` })))
      expect((await fetch(`http://127.0.0.1:${status.host.port}/v1/streams/control`, { method: 'POST', headers: { 'x-alexia-peer': 'a'.repeat(64) } })).status).toBe(403)
      expect(logs.every((line) => !line.includes(secret))).toBe(true)
      await client.close()
      expect(child.exitCode).toBe(0)
    }
    expect(secrets[0] !== secrets[1]).toBe(true)
  })

  test('an unregistered operation is refused by the actual sidecar before core receives it', async () => {
    const { a, b, bId } = await fixture(true)
    const handler = vi.fn()
    b.accept(handler)
    const child = vi.mocked(spawn).mock.results.at(-2)!.value as ReturnType<typeof spawn>
    const secret = String(vi.mocked(child.stdin!.write).mock.calls[0]![0]).trim()
    const response = await fetch(`http://127.0.0.1:${nativePort(child)}/bridge/${bId}/v1/streams/execute`, { method: 'POST', headers: { authorization: `Bearer ${secret}` } })
    expect(response.status).toBe(403)
    expect(response.headers.get('x-alexia-connect-error')).toBe('operation_not_registered')
    expect(handler).not.toHaveBeenCalled()
    expect(await a.identity()).toMatch(/^[a-f0-9]{64}$/)
  })

  test('an absent mailbox is reported as setup-required', async () => {
    const { a, b } = await fixture(true, false)
    await expect(b.pairOpen(hostInfo, new AbortController().signal)).rejects.toMatchObject({ code: 'setup-required' })
    await expect(a.pairJoin('7-alpha-bravo-charlie-delta', controllerInfo, new AbortController().signal)).rejects.toMatchObject({ code: 'setup-required' })
  })
})

// A wire adapter fixture, independent of Rust and the OS keychain. The real sidecar
// suite above proves transport; this fixture checks every pairing outcome and race.
async function pairingFixture(mode = 'success') {
  const dir = mkdtempSync(join(tmpdir(), 'alexia-connect-pairing-wire-'))
  cleanup.push(async () => { rmSync(dir, { recursive: true, force: true }) })
  const executable = join(dir, 'sidecar.cjs')
  writeFileSync(executable, `#!${process.execPath}
    const http = require('node:http'), readline = require('node:readline');
    const mode = ${JSON.stringify(mode)};
    const input = readline.createInterface({ input: process.stdin });
    let server, waiting;
    input.once('line', secret => {
      server = http.createServer((req, res) => {
        if (req.headers.authorization !== 'Bearer ' + secret) { res.writeHead(401); res.end('{}'); return; }
        const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
        if (req.url === '/v1/events') { res.writeHead(200, {'content-type':'text/event-stream'}); res.write('event: snapshot\\ndata: {"peers":[]}\\n\\n'); return; }
        if (req.url === '/v1/pairing/0123456789abcdef?wait=true') {
          if (mode === 'waiting') { waiting = res; return; }
          if (mode === 'expired') { json({state:'failed',error:{code:'pairing_expired'}}); return; }
          if (mode === 'refused') { json({state:'failed',error:{code:'pairing_proof_failed'}}); return; }
          const payload = mode === 'invalid' ? { role:'unknown' } : {role:'compute',platform:'win32',appVersion:'1.0.0',...(mode === 'injected' && {endpointId:'c'.repeat(64),name:'Spoofed name'})};
          json({state:'paired',peer:{endpointId:'b'.repeat(64),name:'Compute host',payload,hints:{relayUrl:null,directAddresses:[]}}}); return;
        }
        if (req.method === 'DELETE' && req.url === '/v1/pairing/0123456789abcdef') {
          if (waiting) waiting.end(JSON.stringify({state:'failed',error:{code:'pairing_cancelled'}}));
          json({cancelled:true}); return;
        }
        let body = ''; req.on('data', bytes => { body += bytes; });
        req.on('end', () => {
          if (req.url === '/v1/pairing/host' || req.url === '/v1/pairing/join') {
            const me = JSON.parse(body);
            if (me.name !== 'Interaction computer' || me.exclusive !== false || JSON.stringify(me.payload) !== JSON.stringify({role:'interaction',platform:'darwin',appVersion:'1.0.0'})) { res.writeHead(400); json({}); return; }
            json({pairingId:'0123456789abcdef',code:'7-alpha-bravo-charlie-delta',expiresAt:Date.now()+300000}); return;
          }
          json({ok:true});
        });
      });
      server.listen(0, '127.0.0.1', () => { process.stdout.write(JSON.stringify({ready:true,protocol:1,port:server.address().port,endpointId:'a'.repeat(64)})+'\\n'); });
    });
    input.on('close', () => { if (server) { server.closeAllConnections(); server.close(() => process.exit(0)); } else process.exit(0); });
  `, { mode: 0o700 })
  const logs: string[] = []
  const client = await connect({ binary: executable, dataDir: dir, role: 'interaction', allow: [], services: { mailbox: 'wss://mailbox.example.org/v1' }, log: (line) => { logs.push(line) } })
  cleanup.push(() => client.close())
  return { client, logs }
}

describe.skipIf(process.platform === 'win32')('pairing wire adapter (executable Node fixture)', () => {
  test('open and join map the opaque payload to PairedPeer without trusting it automatically', async () => {
    const { client, logs } = await pairingFixture()
    const opening = await client.pairOpen(controllerInfo, new AbortController().signal)
    expect(opening.code).toBe('7-alpha-bravo-charlie-delta')
    expect(await opening.done).toEqual({ endpointId: 'b'.repeat(64), ...hostInfo })
    expect(await readConnectHints(client, 'b'.repeat(64))).toEqual({ relayUrl: null, directAddresses: [] })
    expect(await client.pairJoin(opening.code, controllerInfo, new AbortController().signal)).toEqual({ endpointId: 'b'.repeat(64), ...hostInfo })
    await expect(client.open('b'.repeat(64), 'control')).rejects.toMatchObject({ code: 'unpaired' })
    const launch = vi.mocked(spawn).mock.calls.at(-1)![2]!
    expect(launch.env!.ALEXIA_CONNECT_MAILBOX_URL).toBe('wss://mailbox.example.org/v1')
    expect(logs.every((line) => !line.includes(opening.code) && !line.includes(controllerInfo.name))).toBe(true)
  })

  for (const [mode, code] of [['expired', 'expired'], ['refused', 'refused'], ['invalid', 'refused']] as const) {
    test(`maps ${mode} to ${code}`, async () => {
      const { client } = await pairingFixture(mode)
      const opening = await client.pairOpen(controllerInfo, new AbortController().signal)
      await expect(opening.done).rejects.toMatchObject({ code })
    })
  }

  test('opaque payload fields cannot override the proven identity or authenticated name', async () => {
    const { client } = await pairingFixture('injected')
    const opening = await client.pairOpen(controllerInfo, new AbortController().signal)
    expect(await opening.done).toEqual({ endpointId: 'b'.repeat(64), ...hostInfo })
  })

  test('abort sends DELETE and settles the pending outcome as cancelled', async () => {
    const { client } = await pairingFixture('waiting')
    const abort = new AbortController()
    const opening = await client.pairOpen(controllerInfo, abort.signal)
    await pause(30)
    abort.abort()
    await expect(opening.done).rejects.toMatchObject({ code: 'cancelled' })
  })
})
