// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { REMOTE, remoteProvider } from '../src/compute/bridge.js'
import { connect, memoryConnect, readConnectHints, setPeerHints, type Connect, type PairedPeer } from '../src/compute/connect.js'
import { HOSTS_KEY, Hosts } from '../src/compute/hosts.js'
import { ROLE_KEY } from '../src/compute/role.js'
import { computeServe } from '../src/compute/service.js'
import { CANCEL_STOP_MS } from '../src/compute/setup.js'
import { noShell } from '../src/compute/shell.js'
import { remoteModels, TARGET_KEY } from '../src/compute/target.js'
import { ComputeError, IDLE_STOP_MS, qualify, type HostView, type JobProgress, type PairingStatus, type QueueSnapshot, type TargetStatus } from '../src/compute/types.js'
import { pins } from '../src/commands.js'
import { readInstalled } from '../src/installed.js'
import { LLAMA } from '../src/llama.js'
import { LocalRunners, type ManagedRunner } from '../src/localRunners.js'
import type { Machine } from '../src/machine.js'
import type { ModeTransition } from '../src/modeTransition.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve } from '../src/serve.js'
import { Store } from '../src/store.js'
import { chat, type ChatRequest, type Sign } from '../src/provider.js'
import { clock, LAPTOP_MACHINE, laptop, recording, sha256, STUDIO_MACHINE, studio, twoLinks, type StudioOptions } from './fixtures/compute-acceptance.js'
import { RUNNER_SSE, stubRunner } from './fixtures/compute-host.js'
import { mailbox, type Mailbox } from './fixtures/mailbox.js'
import { noPolling } from './staged.js'

/**
 * Plan §13's acceptance tests that can be shown on one machine, through the real code paths.
 * `docs/spec/remote-compute-acceptance.md` maps every checkbox of §13 to the test that proves
 * it, here or elsewhere, and names the ones only real hardware can.
 */

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const uiDir = join(import.meta.dirname, '..', '..', 'ui')
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

/** Write to a data folder's database before a service opens it. */
function seed(root: string, write: (store: Store) => void): void {
  const store = new Store(join(root, 'alexia.db'))
  try { write(store) } finally { store.close() }
}

function temp(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `alexia-acceptance-${name}-`))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  return root
}

// ---------------------------------------------------------------------------------------------
// Pairing and authorization, through the TypeScript client and the real debug sidecar
// ---------------------------------------------------------------------------------------------

const binary = process.env.ALEXIA_CONNECT_TEST_BIN ?? join(import.meta.dirname, '..', '..', '..', 'connect', 'target', 'debug', process.platform === 'win32' ? 'alexia-connect.exe' : 'alexia-connect')
const built = existsSync(binary)
if (!built) process.stderr.write('Skipping the real alexia-connect acceptance tests: build the debug sidecar with ~/.cargo/bin/cargo build --manifest-path connect/Cargo.toml.\n')

const studioInfo = { name: 'Studio', role: 'compute' as const, platform: 'linux', appVersion: '2.0.0' }
const laptopInfo = (name: string) => ({ name, role: 'interaction' as const, platform: 'darwin', appVersion: '1.0.0' })
const signal = (): AbortSignal => new AbortController().signal
/** The same number, and four words that are not the code's. */
const mistyped = (code: string): string => `${code.split('-')[0]!}-wrong-words-entirely-typed`

/** Sidecars on this machine, meeting at a mailbox stub: no key in the keychain, no relay, no address lookup. */
async function sidecars(): Promise<{ post: Mailbox; launch(role: 'interaction' | 'compute'): Promise<Connect> }> {
  const post = await mailbox()
  cleanups.push(() => post.close())
  vi.stubEnv('ALEXIA_CONNECT_EPHEMERAL_KEY', '1')
  vi.stubEnv('ALEXIA_CONNECT_LOOPBACK_HINTS', '1')
  vi.stubEnv('ALEXIA_CONNECT_RELAY_URLS', '')
  vi.stubEnv('ALEXIA_CONNECT_LOOKUP_URL', '')
  const root = temp('sidecars')
  let count = 0
  return {
    post,
    launch: async (role) => {
      const client = await connect({ binary, dataDir: join(root, String(count++)), role, allow: [], services: { mailbox: post.url } })
      cleanups.push(() => client.close())
      return client
    },
  }
}

describe.runIf(built)('pairing through the real sidecar', () => {
  test('a wrong code fails both sides and spends the code; a fresh one pairs once, and trust is still core’s to give', async () => {
    const { post, launch } = await sidecars()
    const [studio, laptop, guesser, latecomer] = [await launch('compute'), await launch('interaction'), await launch('interaction'), await launch('interaction')]
    const [studioId, laptopId] = [await studio.identity(), await laptop.identity()]

    // One attempt per code: a wrong guess ends it on both sides.
    const first = await studio.pairOpen(studioInfo, signal())
    expect(first.code).toMatch(/^\d+(-[a-z]+){4}$/)
    expect(first.expiresAt - Date.now()).toBeGreaterThan(295_000)
    expect(first.expiresAt - Date.now()).toBeLessThanOrEqual(300_000)
    await expect(guesser.pairJoin(mistyped(first.code), laptopInfo('Guesser'), signal())).rejects.toMatchObject({ code: 'refused' })
    await expect(first.done).rejects.toMatchObject({ code: 'refused' })
    // The right code, a moment later, is too late: the attempt was spent.
    await expect(laptop.pairJoin(first.code, laptopInfo('Laptop'), signal())).rejects.toMatchObject({ code: 'refused' })

    // A fresh code is a fresh start, and each side is told the identity the other proved.
    const second = await studio.pairOpen(studioInfo, signal())
    expect(second.code).not.toBe(first.code)
    const joined: PairedPeer = await laptop.pairJoin(second.code, laptopInfo('Laptop'), signal())
    expect(joined).toEqual({ endpointId: studioId, ...studioInfo })
    expect(await second.done).toEqual({ endpointId: laptopId, ...laptopInfo('Laptop') })
    // Nothing of the code went to the mailbox but its number: the words are the shared secret.
    expect(JSON.stringify(post.heard)).not.toContain(second.code.split('-').slice(1).join('-'))

    // Replaying a code that has been used reaches nobody.
    await expect(latecomer.pairJoin(second.code, laptopInfo('Latecomer'), signal())).rejects.toMatchObject({ code: 'refused' })

    // The sidecar proved a peer and allowed nobody: until core allows it, nothing can be opened.
    await expect(laptop.open(studioId, 'control')).rejects.toMatchObject({ code: 'unpaired' })
    await laptop.allow([studioId])
    await studio.allow([laptopId])
    await setPeerHints(laptop, studioId, await readConnectHints(laptop, studioId))
    const arrived = new Promise<{ endpointId: string; kind: string }>((resolve) => { studio.accept((stream, from) => { stream.resume(); resolve(from) }) })
    const stream = await laptop.open(studioId, 'control')
    stream.write('hello\n')
    expect(await arrived).toEqual({ endpointId: laptopId, kind: 'control' })
    stream.destroy()
  }, 120_000)

  test('two computers typing the same code at once: exactly one of them is paired, and the host names that one', async () => {
    const { launch } = await sidecars()
    const [studio, laptop, tablet] = [await launch('compute'), await launch('interaction'), await launch('interaction')]
    const opened = await studio.pairOpen(studioInfo, signal())
    const outcomes = await Promise.allSettled([
      laptop.pairJoin(opened.code, laptopInfo('Laptop'), signal()),
      tablet.pairJoin(opened.code, laptopInfo('Tablet'), signal()),
    ])
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    const lost = outcomes.filter((outcome) => outcome.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'refused' })
    const winner = outcomes[0]!.status === 'fulfilled' ? laptop : tablet
    expect((won[0] as PromiseFulfilledResult<PairedPeer>).value.endpointId).toBe(await studio.identity())
    expect((await opened.done).endpointId).toBe(await winner.identity())
  }, 120_000)
})

// ---------------------------------------------------------------------------------------------
// Two computers in one process: the real host and the real controller, joined by memoryConnect()
// ---------------------------------------------------------------------------------------------

/** A compute host and an interaction computer, paired: each holds the other's record and allows only it. */
async function pairedPair(options: StudioOptions = {}) {
  const { a, b } = memoryConnect()
  const [laptopId, studioId] = [await a.identity(), await b.identity()]
  await a.allow([studioId])
  const host = await studio(temp('studio'), b, laptopId, options)
  const desk = laptop(a, [{ name: host.name, endpointId: studioId }])
  cleanups.push(async () => { await desk.close(); await host.close(); await a.close(); await b.close() })
  const hostId = desk.records[0]!.id
  return { a, b, laptopId, studioId, host, desk, hostId, target: { hostId, modelId: 'llama/test' } }
}

async function runner() {
  const stub = await stubRunner()
  cleanups.push(stub.close)
  return stub
}

/** An answer with no tool call, for the agent loop in `serve()`, which would otherwise go round again. */
const TEXT_SSE = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello, 世界' } }] })}\n\n`,
  `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 }, choices: [] })}\n\n`,
  'data: [DONE]\n\n',
].join('')

const IMAGE = `data:image/png;base64,${Buffer.from(Array.from({ length: 30_000 }, (_, index) => index % 256)).toString('base64')}`
const asked: ChatRequest = {
  model: 'llama/test', maxTokens: 777,
  messages: [
    { role: 'system', content: 'Answer in one sentence.' },
    { role: 'user', content: [{ type: 'text', text: 'What is in this picture, 世界?' }, { type: 'image', url: IMAGE }] },
    { role: 'assistant', content: '', calls: [{ id: 'earlier', name: 'inspect', arguments: '{"name":"b"}' }] },
    { role: 'tool', content: 'a cat', callId: 'earlier' },
  ],
  tools: [{ name: 'inspect', description: 'Inspect a thing.', parameters: { type: 'object', properties: { name: { type: 'string' } } } }],
}

describe('compute jobs', () => {
  test('text, reasoning, tool calls and usage reach the existing chat client through the bridge and the real host exactly as they would directly', async () => {
    const stub = await runner()
    const { desk, host, target } = await pairedPair({ runnerUrl: stub.baseUrl })
    await desk.bridge.select(target, signal())

    const direct = { deltas: [] as string[], signs: [] as Sign[] }
    const remote = { deltas: [] as string[], signs: [] as Sign[] }
    const there = await chat({ ...REMOTE, baseUrl: stub.baseUrl }, asked, (text) => direct.deltas.push(text), undefined, { onSign: (sign) => direct.signs.push(sign) })
    // What the router sends: the catalog's qualified id, which `prepare()` turns into the host's own.
    const through = await chat(remoteProvider(desk.bridge), { ...asked, model: qualify(target) }, (text) => remote.deltas.push(text), undefined, { onSign: (sign) => remote.signs.push(sign) })

    expect(through.message).toEqual(there.message)
    expect(through.message).toMatchObject({ content: 'Hello, 世界', calls: [{ id: 'call-1', name: 'inspect', arguments: '{"name":"a"}' }] })
    expect(through.usage).toEqual({ in: 31, out: 17 })
    expect(through.cut).toBe(there.cut)
    expect(remote.signs).toEqual(direct.signs)
    expect(remote.signs).toEqual(['reasoning', 'content', 'call'])
    expect(remote.deltas).toEqual(direct.deltas)
    // The engine was asked the same thing, byte for byte: the image, the tools, the limit, the host's own model id.
    expect(stub.received).toHaveLength(2)
    expect(stub.received[1]!.equals(stub.received[0]!)).toBe(true)
    expect(JSON.parse(stub.received[1]!.toString('utf8'))).toMatchObject({ model: 'llama/test', max_tokens: 777, stream: true })
    expect(stub.received[1]!.toString('utf8')).toContain(IMAGE)
    // With the runner's own key, which never crossed to the interaction computer.
    expect(stub.headers[1]).toBe('Bearer runner-key')
    expect(host.text.loads).toEqual(['llama/test'])
  })

  test('image bytes and every inference parameter cross the real host unchanged, across stream windows', async () => {
    const stub = await runner()
    const { desk, target } = await pairedPair({ runnerUrl: stub.baseUrl })
    const lease = await desk.bridge.prepare(target)
    const body = Buffer.from(JSON.stringify({
      model: 'llama/test', temperature: 0.37, top_p: 0.91, top_k: 40, min_p: 0.05, seed: 42, stop: ['fin'], repeat_penalty: 1.1,
      response_format: { type: 'json_object' }, custom: { x: '世界' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Look.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${'iVBORw0KGgo'.repeat(40_000)}` } }] }],
    }))
    expect(body.length).toBeGreaterThan(400_000)
    const response = await fetch(`${lease.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${lease.key}` }, body })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(Buffer.from(await response.arrayBuffer()).equals(RUNNER_SSE)).toBe(true)
    expect(stub.received[0]!.equals(body)).toBe(true)
    lease.release()
  })
})

describe('compute jobs: operations, sent where the person chose', () => {
  test('voice: a recording goes to the host as an input and a recording comes back, byte for byte, and nothing runs here', async () => {
    const { desk, host, hostId } = await pairedPair({ plugin: true })
    desk.choose(hostId)
    const here = temp('voice-here')
    const memo = join(here, 'memo.wav')
    const spoken = recording(24_000)
    writeFileSync(memo, recording())

    const heard = await desk.operations.run(
      { cap: 'voice.recognize', args: { file: memo, language: 'en' }, inputs: [{ name: 'memo.wav', path: memo, mime: 'audio/wav' }], toDir: here }, {})
    // The worker read the very bytes this computer recorded, from its own copy on the host.
    expect(JSON.parse(heard.text!)).toEqual({ bytes: readFileSync(memo).length, sha256: sha256(readFileSync(memo)), language: 'en' })
    expect(heard.files).toEqual([])

    const said = await desk.operations.run(
      { cap: 'voice.synthesize', args: { wav: spoken.toString('base64') }, inputs: [], toDir: here }, {})
    expect(said.files).toEqual([join(here, 'spoken.wav')])
    expect(readFileSync(said.files[0]!).equals(spoken)).toBe(true)

    expect(host.plugin!.ran()).toEqual(['voice.recognize', 'voice.synthesize'])
    expect(desk.local.calls).toEqual([])
    // The host keeps neither: the input went when the job ended, the output when it was acknowledged.
    await vi.waitFor(() => { expect(existsSync(join(host.root, 'data', 'compute', 'jobs')) ? readdirSync(join(host.root, 'data', 'compute', 'jobs')) : []).toEqual([]) })
  }, 60_000)

  test('an image render: its progress arrives in order, and the picture is fetched, verified and acknowledged', async () => {
    const { desk, host, hostId } = await pairedPair({ plugin: true })
    desk.choose(hostId)
    const here = temp('render-here')
    const progress: JobProgress[] = []
    const made = await desk.operations.run(
      { cap: 'image.render', args: { prompt: 'a lighthouse at dusk', seed: 7, steps: 20 }, inputs: [], toDir: here },
      { onProgress: (step) => { progress.push(step) } })
    expect(progress).toEqual([
      { progress: 1, total: 3, message: 'Loading checkpoint' },
      { progress: 2, total: 3, message: 'KSampler' },
      { progress: 3, total: 3, message: 'VAE decode' },
    ])
    expect(made.text).toBe('Rendered with 20 steps.')
    expect(made.files).toEqual([join(here, 'render-7.png')])
    expect(readFileSync(made.files[0]!).equals(host.plugin!.png('a lighthouse at dusk'))).toBe(true)
    // Acknowledged: the host's copy is gone now, not at its expiry.
    await vi.waitFor(() => { expect(existsSync(join(host.root, 'data', 'compute', 'jobs')) ? readdirSync(join(host.root, 'data', 'compute', 'jobs')) : []).toEqual([]) })
  }, 60_000)

  test('a queued job is cancelled at once and never runs; a running one is cancelled in its worker; the queue carries on', async () => {
    const workerClock = clock()
    const { desk, host, hostId } = await pairedPair({ plugin: true, workerTimer: workerClock.timer })
    desk.choose(hostId)
    const here = temp('cancel-here')
    const [first, second] = [new AbortController(), new AbortController()]
    const running = desk.operations.run({ cap: 'demo.wait', args: {}, inputs: [], toDir: here }, { signal: first.signal })
    const runningOutcome = running.catch((error: unknown) => error)
    await vi.waitFor(() => { expect(host.plugin!.ran()).toEqual(['demo.wait']) }, { timeout: 30_000 })
    const queued = desk.operations.run({ cap: 'image.render', args: { prompt: 'never', seed: 1, steps: 1 }, inputs: [], toDir: here }, { signal: second.signal })
    const queuedOutcome = queued.catch((error: unknown) => error)
    await vi.waitFor(() => { expect(host.scheduler.queue().waiting).toHaveLength(1) })
    const waiting = host.scheduler.queue().waiting[0]!.id

    // Queued: gone in the same tick, and the worker never hears of it.
    second.abort()
    expect(await queuedOutcome).toMatchObject({ code: 'cancelled' })
    expect(host.scheduler.status(waiting)).toMatchObject({ state: 'cancelled' })
    expect(host.scheduler.queue().waiting).toEqual([])

    // Running: the worker is told by MCP cancellation, and a worker that ignores it is stopped at fifteen seconds.
    const active = host.scheduler.queue().running!.id
    first.abort()
    await vi.waitFor(() => { expect(host.plugin!.cancelled()).toEqual(['demo.wait']) })
    expect(host.scheduler.status(active)!.state).toBe('cancelling')
    await vi.waitFor(() => { expect(workerClock.live(CANCEL_STOP_MS)).toHaveLength(1) })
    workerClock.fire(CANCEL_STOP_MS)
    await vi.waitFor(() => { expect(host.scheduler.status(active)!.state).toBe('cancelled') })
    expect(await runningOutcome).toMatchObject({ code: 'cancelled' })
    expect(host.plugin!.ran()).toEqual(['demo.wait'])

    // Nothing was resubmitted, and the next job runs.
    const next = await desk.operations.run({ cap: 'image.render', args: { prompt: 'after', seed: 2, steps: 4 }, inputs: [], toDir: here }, {})
    expect(next.text).toBe('Rendered with 4 steps.')
    expect(host.plugin!.ran()).toEqual(['demo.wait', 'image.render'])
    expect(desk.local.calls).toEqual([])
  }, 90_000)

  test('a worker that crashes mid-job fails that job as a worker failure, is not run again by it, and the next job starts it afresh', async () => {
    const hostClock = clock()
    const { desk, host, hostId } = await pairedPair({ plugin: true, timer: hostClock.timer })
    desk.choose(hostId)
    const here = temp('crash-here')
    const progress: JobProgress[] = []
    await expect(desk.operations.run({ cap: 'demo.crash', args: {}, inputs: [], toDir: here }, { onProgress: (step) => { progress.push(step) } }))
      .rejects.toMatchObject({ code: 'worker-failure' })
    expect(progress).toEqual([{ progress: 1, total: 2, message: 'About to fall over.' }])
    const crashed = host.plugin!.pids()
    await vi.waitFor(() => { expect(crashed.filter(alive)).toEqual([]) })
    expect(host.plugin!.ran()).toEqual(['demo.crash'])
    expect(desk.jobs.outstanding(hostId)).toEqual([])
    expect(host.scheduler.queue()).toEqual({ waiting: [], paused: false })

    const after = await desk.operations.run({ cap: 'image.render', args: { prompt: 'again', seed: 3, steps: 2 }, inputs: [], toDir: here }, {})
    expect(after.files).toHaveLength(1)
    expect(host.plugin!.ran()).toEqual(['demo.crash', 'image.render'])
    // Whatever was started after the crash, the idle stop leaves no process of it behind.
    hostClock.fire(IDLE_STOP_MS)
    await vi.waitFor(() => { expect(host.plugin!.pids().filter(alive)).toEqual([]) }, { timeout: 15_000 })
  }, 90_000)
})

describe('disconnect and reconnect', () => {
  test('a connection lost mid-answer drops that answer with one stream and no resubmission; once it is back the next answer goes through', async () => {
    const stub = await runner()
    const { a, b, laptopId, desk, target } = await pairedPair({ runnerUrl: stub.baseUrl })
    await desk.bridge.select(target, signal())
    const opened = vi.spyOn(a, 'open')
    stub.respond = (_body, response) => { response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"once","function":{"name":"inspect","arguments":"{"}}]}}]}\n\n') }
    const signs: Sign[] = []
    const answer = chat(remoteProvider(desk.bridge), { ...asked, model: qualify(target) }, undefined, undefined, { onSign: (sign) => signs.push(sign) })
    await vi.waitFor(() => { expect(signs).toEqual(['call']) })
    // The link goes: the host's allowlist drops the controller and takes it back, which closes every stream.
    await b.allow([])
    await b.allow([laptopId])
    await expect(answer).rejects.toMatchObject({ trouble: 'dropped' })
    await vi.waitFor(() => { expect(stub.aborted).toBe(1) })
    expect(stub.received).toHaveLength(1)
    expect(opened.mock.calls.filter(([, kind]) => kind === 'infer')).toHaveLength(1)

    stub.respond = (_body, response) => { response.end(RUNNER_SSE) }
    const again = await chat(remoteProvider(desk.bridge), { ...asked, model: qualify(target) })
    expect(again.message.content).toBe('Hello, 世界')
    expect(stub.received).toHaveLength(2)
    expect(opened.mock.calls.filter(([, kind]) => kind === 'infer')).toHaveLength(2)
  })
})

describe('ten-minute cleanup', () => {
  test('a model left idle is unloaded ten minutes after its last answer, on the injected clock, and the next message loads it again', async () => {
    const stub = await runner()
    const hostClock = clock()
    const { desk, host, target } = await pairedPair({ runnerUrl: stub.baseUrl, timer: hostClock.timer })
    await desk.bridge.select(target, signal())
    await chat(remoteProvider(desk.bridge), { ...asked, model: qualify(target) })
    expect(host.text.loaded).toBe('llama/test')
    // One idle timer for the loaded worker, exactly ten minutes, and nothing that wakes up in between.
    await vi.waitFor(() => { expect(hostClock.live(IDLE_STOP_MS)).toHaveLength(1) })
    expect(hostClock.live().every((one) => one.ms === IDLE_STOP_MS)).toBe(true)
    expect(host.text.stops).toBe(0)
    hostClock.fire(IDLE_STOP_MS)
    await vi.waitFor(() => { expect(host.text.stops).toBe(1) })
    expect(host.text.loaded).toBeUndefined()
    expect(hostClock.live()).toEqual([])

    // The selection stands; the next request re-prepares the same model on the same host.
    const again = await chat(remoteProvider(desk.bridge), { ...asked, model: qualify(target) })
    expect(again.message.content).toBe('Hello, 世界')
    expect(host.text.loads).toEqual(['llama/test', 'llama/test'])
  })

  test('a plugin worker is released and its process stopped ten minutes after its last job', async () => {
    const hostClock = clock()
    const { desk, host, hostId } = await pairedPair({ plugin: true, timer: hostClock.timer })
    desk.choose(hostId)
    await desk.operations.run({ cap: 'image.render', args: { prompt: 'once', seed: 4, steps: 1 }, inputs: [], toDir: temp('idle-here') }, {})
    const running = host.plugin!.pids().filter(alive)
    expect(running).toHaveLength(1)
    await vi.waitFor(() => { expect(hostClock.live(IDLE_STOP_MS).length).toBeGreaterThan(0) })
    expect(host.plugin!.released()).toEqual([])
    hostClock.fire(IDLE_STOP_MS)
    // Its release hook is asked to let go of model memory, and then the process Alexia started is stopped.
    await vi.waitFor(() => { expect(host.plugin!.released()).toEqual(running.map(String)) }, { timeout: 15_000 })
    await vi.waitFor(() => { expect(host.plugin!.pids().filter(alive)).toEqual([]) }, { timeout: 15_000 })
  }, 60_000)
})

describe('plugin removal', () => {
  test('deleting a compute plugin on the host takes away its capabilities and nothing else: chat still answers, and nothing runs here instead', async () => {
    const stub = await runner()
    const { desk, host, hostId, target } = await pairedPair({ plugin: true, runnerUrl: stub.baseUrl, watch: true })
    desk.choose(hostId)
    await desk.controller.ensure(hostId)
    expect(desk.controller.view(hostId)!.inventory!.capabilities.map((one) => one.cap)).toContain('image.render')
    // macOS reports a folder's changes only once its watch has really begun.
    await new Promise((resolve) => setTimeout(resolve, 500))

    rmSync(host.plugin!.dir, { recursive: true, force: true })
    // The host says so unasked: its inventory changes on the interaction computer.
    await vi.waitFor(() => { expect(desk.controller.view(hostId)!.inventory!.capabilities).toEqual([]) }, { timeout: 15_000 })
    expect(desk.controller.view(hostId)!.failure).toBeUndefined()

    await desk.bridge.select(target, signal())
    const answer = await chat(remoteProvider(desk.bridge), { ...asked, model: qualify(target) })
    expect(answer.message.content).toBe('Hello, 世界')
    await expect(desk.operations.run({ cap: 'image.render', args: { prompt: 'gone', seed: 5, steps: 1 }, inputs: [], toDir: temp('removed-here') }, {}))
      .rejects.toMatchObject({ code: 'setup-required' })
    expect(desk.local.calls).toEqual([])
  }, 60_000)

  test('a compute host starts and serves with an enabled plugin whose folder is gone, and with no plugins folder at all', async () => {
    for (const leave of ['enabled-but-gone', 'no-folder'] as const) {
      const root = temp(`startup-${leave}`)
      seed(root, (store) => {
        store.kvSet(CORE, ROLE_KEY, 'compute')
        if (leave === 'enabled-but-gone') store.kvSet(CORE, 'enabled', ['acceptance-worker'])
      })
      if (leave === 'enabled-but-gone') mkdirSync(join(root, 'extensions'), { recursive: true })
      const service = await computeServe({ dataDir: root, uiDir, secrets: memorySecrets(), connect: memoryConnect().b, shell: noShell(), machine: async () => STUDIO_MACHINE })
      cleanups.push(() => service.close())
      const read = await fetch(new URL('/api/compute/inventory', service.url), { headers: { 'x-alexia-token': service.token } })
      expect(read.status).toBe(200)
      const { inventory } = await read.json() as { inventory: { capabilities: unknown[]; machine: Machine } }
      expect(inventory.capabilities).toEqual([])
      expect(inventory.machine.chip).toBe('Studio GPU box')
      await service.close()
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------------------------
// The interaction computer as the app runs it: serve() itself, with one end of the transport
// ---------------------------------------------------------------------------------------------

type Answer<T> = { status: number; body: T }
const client = (base: string, token: string) => async <T = Record<string, unknown>>(path: string, body?: unknown, method?: string): Promise<Answer<T>> => {
  const response = await fetch(new URL(path, base), {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'x-alexia-token': token, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: response.status, body: parsed as T }
}

/** `serve()` on a data folder, with a this-computer runner that records whether anything was ever loaded on it. */
async function desk(connect: Connect, root: string) {
  noPolling(root)
  const baseUrl = 'http://127.0.0.1:1/v1'
  const here = { loads: [] as string[] }
  const runner: ManagedRunner = {
    ensure: async (id) => { here.loads.push(id); return baseUrl },
    acquire: async (id) => { here.loads.push(id); return { baseUrl, key: 'k', release: () => undefined } },
    loaded: () => undefined,
    stop: async () => {},
  }
  const alexia = await serve({
    dataDir: root, uiDir, local: false, providers: [], secrets: memorySecrets(),
    pluginsDir: join(root, 'extensions'), localRunners: new LocalRunners(root, [{ id: 'llama', server: runner, provider: LLAMA }]),
    modeTransitions: { available: () => true, machine: async () => LAPTOP_MACHINE },
    compute: { connect, name: () => 'Laptop', restart: () => {} },
  })
  let closed = false
  const close = async (): Promise<void> => { if (!closed) { closed = true; await alexia.close() } }
  cleanups.push(close)
  return { root, alexia, here, close, ask: client(alexia.url, alexia.token) }
}

/** A laptop data folder that already holds the record of a paired host. */
function pairedFolder(studioId: string, more: (store: Store) => void = () => {}): { root: string; hostId: string } {
  const root = temp('desk')
  let hostId = ''
  seed(root, (store) => {
    hostId = new Hosts(store, 'interaction').add({ name: 'Studio', endpointId: studioId, peerRole: 'compute' }, 1).id
    more(store)
  })
  return { root, hostId }
}

interface State { compute: { hosts: HostView[]; target?: TargetStatus }; modeTransition?: ModeTransition; setup: { mode: string } }

describe('routing and setup', () => {
  test('the same model name on two hosts is two targets: each answer comes from the host that was chosen, and the rows never mix', async () => {
    const first = memoryConnect(), second = memoryConnect()
    const [toStudio, toGarage] = [await first.b.identity(), await second.b.identity()]
    const [studioRunner, garageRunner] = [await runner(), await runner()]
    garageRunner.respond = (_body, response) => { response.end(RUNNER_SSE.toString('utf8').replace('Hello, ', 'Hello from the garage, ')) }
    const studioHost = await studio(temp('studio'), first.b, await first.a.identity(), { name: 'Studio', runnerUrl: studioRunner.baseUrl })
    const garageHost = await studio(temp('garage'), second.b, await second.a.identity(), { name: 'Garage', runnerUrl: garageRunner.baseUrl })
    await first.a.allow([toStudio])
    await second.a.allow([toGarage])
    const desk = laptop(twoLinks(first.a, toStudio, second.a, toGarage), [{ name: 'Studio', endpointId: toStudio }, { name: 'Garage', endpointId: toGarage }])
    cleanups.push(async () => { await desk.close(); await studioHost.close(); await garageHost.close() })
    const [studioId, garageId] = desk.records.map((record) => record.id) as [string, string]
    await desk.controller.ensure(studioId)
    await desk.controller.ensure(garageId)

    // Both hosts have `llama/test`. As catalog rows they are two ids, each saying where it runs.
    const studioRows = remoteModels(desk.controller.views(), studioId)
    const garageRows = remoteModels(desk.controller.views(), garageId)
    expect(studioRows.map((row) => [row.id, row.host])).toEqual([[`@${studioId}/llama/test`, studioId]])
    expect(garageRows.map((row) => [row.id, row.host])).toEqual([[`@${garageId}/llama/test`, garageId]])
    expect(studioRows[0]!.name).toBe(garageRows[0]!.name)

    const toThe = async (hostId: string) => (await chat(remoteProvider(desk.bridge), { ...asked, model: qualify({ hostId, modelId: 'llama/test' }) })).message.content
    expect(await toThe(garageId)).toBe('Hello from the garage, 世界')
    expect(await toThe(studioId)).toBe('Hello, 世界')
    expect(await toThe(garageId)).toBe('Hello from the garage, 世界')
    expect([studioRunner.received.length, garageRunner.received.length]).toEqual([1, 2])
    // Each engine was asked for its own model by its own id, never the qualified one.
    for (const body of [...studioRunner.received, ...garageRunner.received]) expect(JSON.parse(body.toString('utf8')).model).toBe('llama/test')
    expect(studioHost.text.loads).toEqual(['llama/test'])
    expect(garageHost.text.loads.length).toBeGreaterThan(0)
    expect(new Set(garageHost.text.loads)).toEqual(new Set(['llama/test']))
  })

  test('memory fit is judged on the host’s hardware, and a download asked for here lands only on the host', async () => {
    const GiB = 1024 ** 3
    const small = Buffer.from('fake GGUF data')
    const hub = vi.fn(async (url: string | URL | Request) => {
      const path = String(url)
      if (path.includes('test/big') && path.includes('/tree/')) return Response.json([{ type: 'file', path: 'Big-Q4_K_M.gguf', size: 30 * GiB, lfs: { size: 30 * GiB, oid: 'c'.repeat(64) } }])
      if (path.includes('test/big')) return Response.json({ sha: 'b'.repeat(40), gated: false, cardData: { license: 'apache-2.0' }, gguf: { total: 32e9 } })
      if (path.includes('/tree/')) return Response.json([{ type: 'file', path: 'Small-Q4_K_M.gguf', size: small.length, lfs: { size: small.length, oid: sha256(small) } }])
      if (path.includes('/api/models/')) return Response.json({ sha: 'b'.repeat(40), gated: false, cardData: { license: 'apache-2.0' }, gguf: { total: 1e9 } })
      return new Response(small)
    }) as unknown as typeof fetch
    const { a, b } = memoryConnect()
    const [laptopId, studioId] = [await a.identity(), await b.identity()]
    const host = await studio(temp('studio'), b, laptopId, { hub })
    cleanups.push(() => host.close())
    // This computer asks Hugging Face itself only for its own picker; anything that reaches the real one fails the test.
    const own = vi.fn(hub)
    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => (String(input instanceof Request ? input.url : input).includes('huggingface.co') ? own(input) : realFetch(input, init)))
    const { root, hostId } = pairedFolder(studioId)
    const here = await desk(a, root)

    const theirs = (await here.ask<{ quants: { quant: string; verdict: string }[] }>(`/api/local-models/repo?host=${hostId}&repo=test/big`)).body
    const mine = (await here.ask<{ quants: { quant: string; verdict: string }[] }>('/api/local-models/repo?repo=test/big')).body
    // 30 GB of weights: within the host's 80 GB budget, beyond this laptop's 8 GB.
    expect(theirs.quants).toEqual([expect.objectContaining({ quant: 'Q4_K_M', verdict: expect.stringMatching(/^(fits|tight)$/) })])
    expect(mine.quants).toEqual([expect.objectContaining({ quant: 'Q4_K_M', verdict: 'too-big' })])
    expect((await here.ask<{ machine: Machine }>(`/api/local-models?host=${hostId}`)).body.machine.chip).toBe('Studio GPU box')

    const installing = vi.spyOn(host.local, 'install')
    const started = await here.ask<{ id: string }>('/api/local-models/install', { host: hostId, repo: 'test/small', quant: 'Q4_K_M', mode: 'local' })
    expect(started.status).toBe(202)
    await vi.waitFor(async () => { expect((await here.ask<{ step: string }>(`/api/local-models/progress?host=${hostId}&job=${started.body.id}`)).body.step).toBe('done') })
    // The host's own picker ran the install, without this computer's mode, and the weights are on the host's disk.
    expect(installing).toHaveBeenCalledTimes(1)
    expect(installing.mock.calls[0]![0]).toEqual({ repo: 'test/small', quant: 'Q4_K_M' })
    expect(readInstalled(host.root).map((one) => one.repo)).toContain('test/small')
    // And nothing on this computer: no record, and no weights anywhere in its data folder.
    expect(readInstalled(root)).toEqual([])
    const files = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' })
    expect(files(root).filter((name) => /\.gguf(\.part)?$/i.test(name))).toEqual([])
    expect(files(host.root).filter((name) => name.endsWith('Small-Q4_K_M.gguf'))).toHaveLength(1)
  }, 60_000)

  test('a selection saved before paired computers existed reads as this computer when the app starts, and nothing else is rewritten', async () => {
    const root = temp('migrate')
    seed(root, (store) => {
      store.kvSet(CORE, 'last_local_model', 'llama/old')
      store.kvSet(CORE, 'pins', { model: 'llama/old', order: ['llama/old', 'openai/gpt'] })
    })
    const here = await desk(memoryConnect().a, root)
    expect(here.alexia.store.kvGet(CORE, TARGET_KEY)).toEqual({ hostId: 'this', modelId: 'llama/old' })
    expect(here.alexia.store.kvGet(CORE, 'last_local_model')).toBe('llama/old')
    expect(here.alexia.store.kvGet(CORE, 'pins')).toEqual({ model: 'llama/old', order: ['llama/old', 'openai/gpt'] })
    expect(here.alexia.store.kvGet(CORE, HOSTS_KEY)).toBeUndefined()
  })

  test('a strict target: with the chosen host offline, a message says so and nothing is loaded here or anywhere else; when it is back, it answers', async () => {
    const stub = await runner()
    stub.respond = (_body, response) => { response.end(TEXT_SSE) }
    const { a, b } = memoryConnect()
    const [laptopId, studioId] = [await a.identity(), await b.identity()]
    const host = await studio(temp('studio'), b, laptopId, { runnerUrl: stub.baseUrl })
    cleanups.push(() => host.close())
    const { root, hostId } = pairedFolder(studioId)
    const here = await desk(a, root)
    const id = `@${hostId}/llama/test`
    expect((await here.ask('/api/local-models/use', { id })).status).toBe(200)
    await vi.waitFor(async () => { expect((await here.ask<State>('/api/state')).body.modeTransition?.phase).toBe('ready') })
    const say = async (text: string): Promise<string> => (await fetch(new URL('/api/chat', here.alexia.url), {
      method: 'POST', headers: { 'x-alexia-token': here.alexia.token, 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    })).text()
    expect(await say('Hello?')).toContain('Hello, 世界')
    expect(stub.received).toHaveLength(1)

    // The host goes away: every stream to it breaks and nothing new can be opened.
    const open = vi.spyOn(a, 'open').mockRejectedValue(new ComputeError('offline', 'That computer cannot be reached right now.'))
    await b.allow([])
    await b.allow([laptopId])
    const refused = await say('Are you there?')
    // The pinned plan of one model failed, and the answer is an error: no other model was asked.
    expect(refused).toContain('"error"')
    expect(refused).toContain('"chosen":"pinned"')
    expect(refused).not.toContain('Hello, 世界')
    expect(stub.received).toHaveLength(1)
    // Nothing was loaded on this computer, the choice is unchanged, and the host is shown as what it is.
    expect(here.here.loads).toEqual([])
    expect(pins(here.alexia.store).model).toBe(id)
    expect(here.alexia.store.kvGet(CORE, TARGET_KEY)).toEqual({ hostId, modelId: 'llama/test' })
    await vi.waitFor(async () => {
      const [view] = (await here.ask<{ hosts: HostView[] }>('/api/compute/hosts')).body.hosts
      expect(view).toMatchObject({ host: { id: hostId }, failure: { code: 'offline' } })
    })

    open.mockRestore()
    await vi.waitFor(async () => { expect(await say('And now?')).toContain('Hello, 世界') }, { timeout: 15_000, interval: 500 })
    expect(here.here.loads).toEqual([])
  }, 60_000)
})

/**
 * Finding 1 in docs/spec/remote-compute-acceptance.md, now fixed in router.ts `stopped()`: when the
 * chosen paired computer cannot be reached, the chat's error names that computer instead of the
 * generic sentence for a lost internet connection.
 */
test('an unreachable paired computer is not described to the person as their own internet connection being down', async () => {
  const { a, b } = memoryConnect()
  const [laptopId, studioId] = [await a.identity(), await b.identity()]
  const stub = await runner()
  stub.respond = (_body, response) => { response.end(TEXT_SSE) }
  const host = await studio(temp('studio'), b, laptopId, { runnerUrl: stub.baseUrl })
  cleanups.push(() => host.close())
  const { root, hostId } = pairedFolder(studioId)
  const here = await desk(a, root)
  await here.ask('/api/local-models/use', { id: `@${hostId}/llama/test` })
  await vi.waitFor(async () => { expect((await here.ask<State>('/api/state')).body.modeTransition?.phase).toBe('ready') })
  vi.spyOn(a, 'open').mockRejectedValue(new ComputeError('offline', 'That computer cannot be reached right now.'))
  await b.allow([])
  const said = await (await fetch(new URL('/api/chat', here.alexia.url), {
    method: 'POST', headers: { 'x-alexia-token': here.alexia.token, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Are you there?' }),
  })).text()
  expect(said).toContain('"error"')
  expect(said).not.toMatch(/internet connection/i)
}, 60_000)

describe('pairing survives a restart', () => {
  test('both computers, started again on the same data with a sidecar that allows nobody, allow each other from the stored record and reconnect', async () => {
    const { a, b } = memoryConnect()
    const [laptopId, studioId] = [await a.identity(), await b.identity()]
    // The compute host: its record of the controller, and the role, written before it starts.
    const studioRoot = temp('studio-restart')
    seed(studioRoot, (store) => {
      store.kvSet(CORE, ROLE_KEY, 'compute')
      new Hosts(store, 'compute').add({ name: 'Laptop', endpointId: laptopId, peerRole: 'interaction' }, 1)
    })
    const { root, hostId } = pairedFolder(studioId)
    // A restarted sidecar starts with an empty allowlist. memoryConnect() cannot be launched twice, so its ends are kept open across the restart.
    const keep = [vi.spyOn(a, 'close').mockResolvedValue(undefined), vi.spyOn(b, 'close').mockResolvedValue(undefined)]
    const allowedHere = vi.spyOn(a, 'allow'), allowedThere = vi.spyOn(b, 'allow')

    for (const launch of [1, 2]) {
      await a.allow([])
      await b.allow([])
      await expect(a.open(studioId, 'control')).rejects.toMatchObject({ code: 'unpaired' })
      allowedHere.mockClear()
      allowedThere.mockClear()
      const service = await computeServe({ dataDir: studioRoot, uiDir, secrets: memorySecrets(), connect: b, shell: noShell(), machine: async () => STUDIO_MACHINE })
      const here = await desk(a, root)
      expect(allowedThere).toHaveBeenCalledWith([laptopId])
      expect(allowedHere).toHaveBeenCalledWith([studioId])
      await vi.waitFor(async () => {
        const [view] = (await here.ask<{ hosts: HostView[] }>('/api/compute/hosts')).body.hosts
        expect(view, `launch ${launch}`).toMatchObject({ host: { id: hostId, endpointId: studioId }, connection: 'direct', inventory: { machine: { chip: 'Studio GPU box' } } })
      }, { timeout: 15_000 })
      await here.close()
      await service.close()
    }
    for (const spy of keep) spy.mockRestore()
    await a.close()
    await b.close()
  }, 60_000)
})

describe('revocation', () => {
  test('unpairing at the host breaks an answer in flight at once, cancels the job queued behind it, and the controller is told it is unpaired', async () => {
    const stub = await runner()
    const { a, desk, host, hostId, studioId, target } = await pairedPair({ plugin: true, runnerUrl: stub.baseUrl })
    desk.choose(hostId)
    await desk.bridge.select(target, signal())
    stub.respond = (_body, response) => { response.write('data: {"choices":[{"delta":{"content":"begun"}}]}\n\n') }
    const deltas: string[] = []
    const answer = chat(remoteProvider(desk.bridge), { ...asked, model: qualify(target) }, (text) => deltas.push(text)).catch((error: unknown) => error)
    await vi.waitFor(() => { expect(deltas).toEqual(['begun']) })
    // An answer is the one heavy job running; the operation waits behind it.
    const job = desk.operations.run({ cap: 'demo.wait', args: {}, inputs: [], toDir: temp('revoke-here') }, {}).catch((error: unknown) => error)
    await vi.waitFor(() => { expect(host.scheduler.queue().waiting).toHaveLength(1) })
    const waiting = host.scheduler.queue().waiting[0]!.id

    await host.protocol.revoke()
    // Done before revoke() returned: nobody is paired, and the queued job is gone.
    expect(host.hosts.list()).toEqual([])
    expect(host.scheduler.status(waiting)!.state).toBe('cancelled')
    expect(await answer).toMatchObject({ trouble: 'dropped' })
    await vi.waitFor(() => { expect(stub.aborted).toBe(1) })
    expect(await job).toBeInstanceOf(ComputeError)
    expect(host.plugin!.ran()).toEqual([])
    await expect(a.open(studioId, 'control')).rejects.toBeInstanceOf(ComputeError)
    await vi.waitFor(() => { expect(desk.controller.view(hostId)!.failure?.code).toMatch(/^(unpaired|offline)$/) })
    expect(desk.local.calls).toEqual([])
  }, 60_000)
})

describe.runIf(built)('two Alexias and two real sidecars', () => {
  test('paired over their own routes by a code, with no relay, no address lookup and no internet, then the host answers over the real transport', async () => {
    const { post } = await sidecars()
    vi.stubEnv('ALEXIA_CONNECT_MAILBOX_URL', post.url)
    const studioRoot = temp('studio-real')
    seed(studioRoot, (store) => { store.kvSet(CORE, ROLE_KEY, 'compute') })
    const service = await computeServe({ dataDir: studioRoot, uiDir, secrets: memorySecrets(), binary, shell: noShell(), machine: async () => STUDIO_MACHINE })
    cleanups.push(() => service.close())
    const there = client(service.url, service.token)
    const root = temp('desk-real')
    noPolling(root)
    const alexia = await serve({
      dataDir: root, uiDir, local: false, providers: [], secrets: memorySecrets(), pluginsDir: join(root, 'extensions'),
      modeTransitions: { available: () => true, machine: async () => LAPTOP_MACHINE },
      compute: { binary, name: () => 'Laptop', restart: () => {} },
    })
    cleanups.push(() => alexia.close())
    const here = client(alexia.url, alexia.token)

    const opened = await there<{ pairing: PairingStatus }>('/api/compute/pair/start', {})
    expect(opened.status).toBe(200)
    const code = opened.body.pairing.code!
    expect((await here<{ pairing: PairingStatus }>('/api/compute/pair/start', { code })).body.pairing.phase).toBe('connecting')
    let hostId = ''
    await vi.waitFor(async () => {
      const mine = (await here<{ pairing?: PairingStatus }>('/api/compute/pair')).body.pairing
      expect(mine).toMatchObject({ phase: 'paired' })
      hostId = mine!.hostId!
    }, { timeout: 30_000, interval: 200 })
    await vi.waitFor(async () => { expect((await there<{ pairing?: PairingStatus }>('/api/compute/pair')).body.pairing).toMatchObject({ phase: 'paired', peerName: 'Laptop' }) }, { timeout: 30_000, interval: 200 })
    // Each keeps the other's public identity and nothing else; the code is spent.
    const studioEndpoint = (alexia.store.kvGet(CORE, HOSTS_KEY) as { endpointId: string }[])[0]!.endpointId
    expect(studioEndpoint).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(alexia.store.kvGet(CORE, HOSTS_KEY))).not.toContain(code.split('-').slice(1).join('-'))
    expect(await there('/api/compute/pair/start', {})).toMatchObject({ status: 409, body: { code: 'refused' } })

    // Over the real transport: the host's inventory and its own picker, with its hardware.
    await vi.waitFor(async () => {
      const [view] = (await here<{ hosts: HostView[] }>('/api/compute/hosts')).body.hosts
      expect(view).toMatchObject({ host: { id: hostId }, connection: 'direct', inventory: { machine: { chip: 'Studio GPU box' } } })
    }, { timeout: 30_000, interval: 300 })
    expect((await here<{ machine: Machine }>(`/api/local-models?host=${hostId}`)).body.machine.chip).toBe('Studio GPU box')
    expect((await here<{ queue: QueueSnapshot }>(`/api/compute/queue?host=${hostId}`)).body.queue).toEqual({ waiting: [], paused: false })
    // With no host named, the queue is the selected computer's: where picture jobs run.
    const before = alexia.store.kvGet(CORE, TARGET_KEY)
    alexia.store.kvSet(CORE, TARGET_KEY, { hostId, modelId: 'llama/any' })
    expect((await here<{ queue: QueueSnapshot }>('/api/compute/queue')).body.queue).toEqual({ waiting: [], paused: false })
    alexia.store.kvSet(CORE, TARGET_KEY, before ?? null)
    expect((await there<{ hosts: HostView[] }>('/api/compute/hosts')).body.hosts).toEqual([expect.objectContaining({ host: expect.objectContaining({ name: 'Laptop' }) })])

    // Unpaired from the host: the interaction computer can no longer reach it, and says so.
    const controllerId = (await there<{ hosts: HostView[] }>('/api/compute/hosts')).body.hosts[0]!.host.id
    expect((await there('/api/compute/unpair', { host: controllerId, confirm: true })).body).toEqual({ ok: true })
    await vi.waitFor(async () => {
      const [view] = (await here<{ hosts: HostView[] }>('/api/compute/hosts')).body.hosts
      expect(view!.failure?.code).toMatch(/^(unpaired|offline)$/)
    }, { timeout: 30_000, interval: 300 })
    expect(await here(`/api/compute/queue?host=${hostId}`)).toMatchObject({ body: { ok: false } })
  }, 120_000)
})

describe.runIf(built)('a render over two real sidecars', () => {
  test('the picture the host made reaches the controller, and the host’s copy is acknowledged away', async () => {
    const { launch } = await sidecars()
    const [a, b] = [await launch('interaction'), await launch('compute')]
    const [laptopId, studioId] = [await a.identity(), await b.identity()]
    await a.allow([studioId])
    await b.allow([laptopId])
    await setPeerHints(a, studioId, await readConnectHints(b))
    await setPeerHints(b, laptopId, await readConnectHints(a))
    const host = await studio(temp('studio-real-render'), b, laptopId, { plugin: true })
    const desk = laptop(a, [{ name: host.name, endpointId: studioId }])
    cleanups.push(async () => { await desk.close(); await host.close() })
    desk.choose(desk.records[0]!.id)
    const here = temp('render-real-here')
    const progress: JobProgress[] = []
    const made = await desk.operations.run(
      { cap: 'image.render', args: { prompt: 'a lighthouse at dusk', seed: 7, steps: 20 }, inputs: [], toDir: here },
      { onProgress: (step) => { progress.push(step) } })
    expect(progress.length).toBeGreaterThan(0)
    expect(made.files).toEqual([join(here, 'render-7.png')])
    expect(readFileSync(made.files[0]!).equals(host.plugin!.png('a lighthouse at dusk'))).toBe(true)
    await vi.waitFor(() => { expect(existsSync(join(host.root, 'data', 'compute', 'jobs')) ? readdirSync(join(host.root, 'data', 'compute', 'jobs')) : []).toEqual([]) })
  }, 90_000)
})
