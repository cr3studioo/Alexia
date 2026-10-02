// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Model } from '../src/catalog.js'
import { pins, rememberLocalChoice, setPin } from '../src/commands.js'
import { remoteModel, selectedTarget, TARGET_KEY } from '../src/compute/target.js'
import { ComputeError, parseCatalogId, qualify, REMOTE_PROVIDER, type ExecutionTarget, type HostModel, type TargetStatus } from '../src/compute/types.js'
import { remember, type Installed } from '../src/installed.js'
import type { Machine } from '../src/machine.js'
import { ModeTransitions, type ModeTransitionOptions } from '../src/modeTransition.js'
import { chat, type Provider } from '../src/provider.js'
import { asSentence, MODES, route, send, type World } from '../src/router.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'

// The seams remote compute cuts into files that existed before it: what the router may reach,
// what the request names, and what a mode switch does when the model is on another computer.

const HOST = 'k3x9q2m7vd4p'
const OTHER = 'w8n5t1r6ja2c'
const hostModel: HostModel = { id: 'llama/x', name: 'Model X', engine: 'llama', context: 8192, supportsTools: true, modality: ['text', 'image'], params: 8, loaded: false }
const onHost = remoteModel(HOST, hostModel)
const onOther = remoteModel(OTHER, hostModel)
const onThis: Model = { id: 'llama/x', name: 'Model X', provider: 'llama', tier: 'T0', priceIn: 0, priceOut: 0, context: 8192, params: 8, supportsTools: true, modality: ['text', 'image'], nsfwOk: 'unknown', trainsOnYourData: 'no' }

// One stub engine: it keeps what it was sent and answers with every kind of thing a stream carries.
let bodies: Record<string, unknown>[] = []
let authorization: string | undefined
let hang = false
let closed = 0
const SSE = [
  { model: 'engine-x', choices: [{ delta: { reasoning_content: 'thinking' } }] },
  { choices: [{ delta: { content: 'Hello ' } }] },
  { choices: [{ delta: { content: 'there' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'look', arguments: '{"at":' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"sky"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
]
const engine = createServer((request, response) => {
  authorization = request.headers.authorization
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (hang) {
      response.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n')
      response.on('close', () => { closed += 1 })
      return
    }
    response.end(`${SSE.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`)
  })
})
await new Promise<void>((resolve) => engine.listen(0, '127.0.0.1', resolve))
afterAll(() => { engine.closeAllConnections(); engine.close() })
beforeEach(() => { bodies = []; authorization = undefined; hang = false; closed = 0 })
// A loopback address, exactly as the bridge to a paired computer has one.
const baseUrl = `http://127.0.0.1:${String((engine.address() as AddressInfo).port)}/lease-token`
const llama: Provider = { id: 'llama', name: 'llama.cpp', baseUrl: '', auth: 'none' }
const remote = (prepare: Provider['prepare'] = async (model) => ({ baseUrl, key: 'lease-key', model: parseCatalogId(model).modelId })): Provider =>
  ({ id: REMOTE_PROVIDER, name: 'Paired computer', baseUrl: '', auth: 'none', prepare })

const status = (target: ExecutionTarget, phase: TargetStatus['phase'], message: string): TargetStatus =>
  ({ target, phase, connection: phase === 'offline' ? 'offline' : 'direct', message })
const world = (over: Partial<World> = {}): World => ({ models: [], local: [onThis, onHost], runners: [llama, remote()], rungs: [], ...over })
const asked = [{ role: 'user' as const, content: 'hello' }]
const plan = (verdict: ReturnType<typeof route>): string[] =>
  verdict.ok ? verdict.choices.map((choice) => `${choice.provider.id} ${choice.model.id}`) : [verdict.why]

test('prepare().model is what the request names, and everything else arrives as it was asked', async () => {
  const release = vi.fn()
  const prepare = vi.fn(async (model: string) => ({ baseUrl, key: 'lease-key', model: parseCatalogId(model).modelId, release }))
  const picture = 'data:image/png;base64,iVBORw0KGgo='
  const heard: string[] = []
  const signs: string[] = []
  const answer = await chat(remote(prepare), {
    model: onHost.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', url: picture }] }],
    tools: [{ name: 'look', description: 'Look at something.', parameters: { type: 'object', properties: { at: { type: 'string' } } } }],
    maxTokens: 321,
  }, (text) => heard.push(text), memorySecrets(), { onSign: (kind) => signs.push(kind) })

  expect(prepare).toHaveBeenCalledWith(`@${HOST}/llama/x`, undefined)
  const [body] = bodies
  // The engine's own id: the host never sees a host-qualified one.
  expect(body?.model).toBe('llama/x')
  expect(body).toMatchObject({
    max_tokens: 321, stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: picture } }] }],
    tools: [{ type: 'function', function: { name: 'look', parameters: { type: 'object' } } }],
  })
  expect(authorization).toBe('Bearer lease-key')
  // Streaming, reasoning, the tool call and the usage, through the one client there is.
  expect(heard).toEqual(['Hello ', 'there'])
  expect(signs).toEqual(['reasoning', 'content', 'call'])
  expect(answer.message.content).toBe('Hello there')
  expect(answer.message.calls).toEqual([{ id: 'call_1', name: 'look', arguments: '{"at":"sky"}' }])
  expect(answer.usage).toEqual({ in: 11, out: 7 })
  expect(release).toHaveBeenCalledOnce()
})

test('a preparation that names no model leaves the request’s own id in the body', async () => {
  await chat({ ...llama, prepare: async () => baseUrl }, { model: onThis.id, messages: asked }, undefined, memorySecrets())
  await chat({ ...llama, prepare: async () => ({ baseUrl }) }, { model: onThis.id, messages: asked }, undefined, memorySecrets())
  await chat({ ...llama, baseUrl }, { model: onThis.id, messages: asked }, undefined, memorySecrets())
  expect(bodies.map((body) => body.model)).toEqual(['llama/x', 'llama/x', 'llama/x'])
})

test('stopping an answer from a paired computer closes its one request and releases the lease', async () => {
  hang = true
  const release = vi.fn()
  const stop = new AbortController()
  const answer = chat(remote(async (model) => ({ baseUrl, model: parseCatalogId(model).modelId, release })),
    { model: onHost.id, messages: asked, signal: stop.signal }, () => stop.abort(new Error('stopped')), memorySecrets())
  await expect(answer).rejects.toBeDefined()
  await vi.waitFor(() => expect(closed).toBe(1))
  expect(bodies).toHaveLength(1)
  expect(release).toHaveBeenCalledOnce()
})

test('a paired computer’s model is routed in Local, and in no other placement', () => {
  const pinned = { placement: MODES.local, model: onHost.id }
  expect(plan(route({ messages: asked }, pinned, world()))).toEqual([`${REMOTE_PROVIDER} @${HOST}/llama/x`])
  expect(plan(route({ messages: asked }, { placement: MODES.local }, world({ local: [onHost] })))).toEqual([`${REMOTE_PROVIDER} @${HOST}/llama/x`])

  // Cloud and Combined keep "the APIs, then this machine": the paired computer is not this machine.
  for (const placement of [MODES.cloud, MODES.combined]) {
    expect(plan(route({ messages: asked }, { placement }, world()))).toEqual(['llama llama/x'])
    expect(plan(route({ messages: asked }, { placement, model: onHost.id }, world()))).toEqual([`@${HOST}/llama/x is not available right now.`])
    expect(route({ messages: asked }, { placement }, world({ local: [onHost] })).ok).toBe(false)
  }
})

test('a loopback address is not where a model runs: Model.host is', () => {
  // The same address and the same tier as a runner on this computer, and still kept out of Cloud.
  const bridged = remote(async () => baseUrl)
  const here: Provider = { ...llama, baseUrl }
  const everywhere = world({ runners: [here, { ...bridged, baseUrl }] })
  expect(plan(route({ messages: asked }, { placement: MODES.cloud }, everywhere))).toEqual(['llama llama/x'])
  // And a row that says nothing about a host is this computer's, whatever serves it.
  const unhosted: Model = { ...onThis, id: onHost.id, provider: REMOTE_PROVIDER }
  expect(plan(route({ messages: asked }, { placement: MODES.cloud }, world({ local: [unhosted] })))).toEqual([`${REMOTE_PROVIDER} @${HOST}/llama/x`])
})

test('the same model on two paired computers is two rows, and only the selected one is reached', () => {
  expect(onHost.name).toBe(onOther.name)
  expect(onHost.id).not.toBe(onOther.id)
  expect([onHost.host, onOther.host]).toEqual([HOST, OTHER])
  expect(parseCatalogId(onHost.id)).toEqual({ hostId: HOST, modelId: 'llama/x' })
  expect(parseCatalogId(onOther.id)).toEqual({ hostId: OTHER, modelId: 'llama/x' })

  const both = world({ local: [onThis, onOther, onHost] })
  for (const one of [onHost, onOther, onThis]) {
    const verdict = route({ messages: asked }, { placement: MODES.local, model: one.id }, both)
    expect(verdict.ok && verdict.choices.map((choice) => [choice.model.id, choice.model.host])).toEqual([[one.id, one.host]])
  }

  // With a target selected, a row on another host is not reachable at all — pinned or not.
  const selected = world({ local: [onOther, onHost], target: status({ hostId: HOST, modelId: 'llama/x' }, 'ready', 'Ready.') })
  expect(plan(route({ messages: asked }, { placement: MODES.local }, selected))).toEqual([`${REMOTE_PROVIDER} @${HOST}/llama/x`])
  expect(plan(route({ messages: asked }, { placement: MODES.local, model: onOther.id }, selected))).toEqual([`@${OTHER}/llama/x is not available right now.`])
})

test('with a paired computer selected and nothing to route, the refusal is that computer’s own state', () => {
  const offline = status({ hostId: HOST, modelId: 'llama/x' }, 'offline', 'That computer is offline.')
  const verdict = route({ messages: asked }, { placement: MODES.local }, world({ local: [], target: offline }))
  expect(verdict.ok).toBe(false)
  if (!verdict.ok) expect(asSentence(verdict.why)).toBe('That computer is offline.')
  // No target, and it is the sentence it always was.
  expect(plan(route({ messages: asked }, { placement: MODES.local }, world({ local: [] })))).toEqual(['no model is installed on this Mac — install one, or type /cloud'])
})

test('a paired computer is the person’s own hardware: nothing is stripped on the way to it (§11 item 1)', async () => {
  // The contract's default. The stricter reading is one line in `router.ts` (`owned`), and
  // changing it turns this test's expectations into the hosted provider's below.
  const secret = 'put OPENROUTER_API_KEY=sk-or-v1-9f2a8c7b6d5e4f3a2b1c0d9e in .env'
  const ledger = new Store(':memory:')
  const notes: string[] = []
  try {
    await send([{ model: onHost, provider: remote() }], { messages: [{ role: 'user', content: secret }] }, ledger, memorySecrets(), { onNote: (line) => notes.push(line) })
    const hostedRow: Model = { ...onThis, id: 'free/text', provider: 'alpha', tier: 'T1' }
    await send([{ model: hostedRow, provider: { id: 'alpha', name: 'Alpha', baseUrl, auth: 'none' } }], { messages: [{ role: 'user', content: secret }] }, ledger, memorySecrets(), { onNote: (line) => notes.push(line) })
  } finally { ledger.close() }
  const sent = bodies.map((body) => (body.messages as { content: string }[])[0]?.content)
  expect(bodies[0]?.model).toBe('llama/x')
  expect(sent[0]).toBe(secret)
  expect(sent[1]).toBe('put OPENROUTER_API_KEY=[redacted] in .env')
  expect(notes.filter((line) => line.startsWith('Stripped'))).toHaveLength(1)
})

test('choosing a paired computer’s model remembers the target; this computer’s keeps both records in step', () => {
  const store = new Store(':memory:')
  try {
    setPin(store, { model: 'llama/mine' })
    expect(store.kvGet(CORE, TARGET_KEY)).toEqual({ hostId: 'this', modelId: 'llama/mine' })
    expect(store.kvGet(CORE, 'last_local_model')).toBe('llama/mine')

    setPin(store, { model: onHost.id })
    expect(pins(store).model).toBe(`@${HOST}/llama/x`)
    expect(selectedTarget(store)).toEqual({ hostId: HOST, modelId: 'llama/x' })
    // The record an older build reads stays a model on this computer.
    expect(store.kvGet(CORE, 'last_local_model')).toBe('llama/mine')

    // A hosted pin is not a local choice, and forgets nothing.
    setPin(store, { model: 'free/text' })
    expect(selectedTarget(store)).toEqual({ hostId: HOST, modelId: 'llama/x' })
    rememberLocalChoice(store, 'qwen3:8b')
    expect(selectedTarget(store)).toEqual({ hostId: 'this', modelId: 'qwen3:8b' })
    expect(store.kvGet(CORE, 'last_local_model')).toBe('qwen3:8b')
  } finally { store.close() }
})

const GB = 1024 ** 3
const machine = (): Machine => ({ platform: 'darwin', arch: 'arm64', appleSilicon: true, chip: 'Test', ramBytes: 32 * GB, freeDiskBytes: 20 * GB, budgetBytes: 16 * GB })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function fixture(options: { remote?: false; hostName?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'alexia-seams-'))
  const store = new Store(join(root, 'alexia.db'))
  store.kvSet(CORE, 'mode', 'cloud')
  store.kvSet(CORE, 'pins', { model: 'cloud/previous', order: ['cloud/previous'], prefer: 'best', spend: 'free' })
  let loaded: { model: string; baseUrl: string; since: number } | undefined
  const order: string[] = []
  const runners = {
    loaded: () => loaded,
    stop: vi.fn(async () => { order.push('stop'); loaded = undefined }),
    ensure: vi.fn(async (model: string) => { order.push('ensure'); loaded = { model, baseUrl: 'http://127.0.0.1:1/v1', since: Date.now() }; return loaded.baseUrl }),
  }
  const select = vi.fn<NonNullable<ModeTransitionOptions['remote']>['select']>(async (target, _signal, onStatus) => {
    order.push('select')
    onStatus?.(status(target, 'connecting', 'Connecting to the paired computer.'))
    onStatus?.(status(target, 'ready', 'Ready.'))
    return { id: target.modelId, name: 'Model X' }
  })
  const deselect = vi.fn(async () => { order.push('deselect') })
  const probe = vi.fn(async () => machine())
  const external = vi.fn(async () => undefined)
  const controller = new ModeTransitions({
    store, dataDir: root, runners, busy: () => false, machine: probe, available: () => true, external,
    ...(options.remote !== false && { remote: { select, deselect, ...(options.hostName && { hostName: () => 'Workstation' }) } }),
  })
  cleanups.push(async () => { await controller.close(); store.close(); rmSync(root, { recursive: true, force: true }) })
  const install = (name: string): Installed => {
    const file = join(root, `${name}.gguf`)
    writeFileSync(file, 'GGUF')
    const one: Installed = { id: `llama/${name}`, name, repo: 'test/model', revision: 'a'.repeat(40), quant: 'Q4', files: [file], bytes: GB, context: 4096, contextMax: 8192, kvBytesPerToken: 1024, ready: true, tools: true, vision: false, abliterated: false, nsfwOk: 'unknown', vetted: false, installedAt: Date.now() }
    remember(root, one)
    return one
  }
  return { store, runners, select, deselect, probe, external, controller, install, order, load: (model: string) => { loaded = { model, baseUrl: 'http://127.0.0.1:1/v1', since: Date.now() } } }
}
const settle = async (controller: ModeTransitions) => {
  await vi.waitFor(() => expect(controller.pending()).toBe(false))
  return controller.status()!
}
const TARGET: ExecutionTarget = { hostId: HOST, modelId: 'llama/x' }

test('selecting a paired computer’s model unloads this computer’s, carries the target’s status, and commits only when it is ready', async () => {
  const f = fixture({ hostName: true })
  f.install('x')
  f.load('llama/x')
  let ready!: () => void
  f.select.mockImplementationOnce(async (target, _signal, onStatus) => {
    f.order.push('select')
    onStatus?.(status(target, 'connecting', 'Connecting to the paired computer.'))
    onStatus?.({ ...status(target, 'queued', 'Waiting for that computer to be free.'), position: 2 })
    await new Promise<void>((resolve) => { ready = resolve })
    onStatus?.(status(target, 'loading', 'Loading Model X on that computer.'))
    return { id: target.modelId, name: 'Model X' }
  })
  f.controller.request('local', qualify(TARGET))
  await vi.waitFor(() => expect(f.controller.status()?.targetStatus?.phase).toBe('queued'))
  expect(f.controller.status()).toMatchObject({
    phase: 'loading', target: TARGET, message: 'Waiting for that computer to be free.',
    targetStatus: { target: TARGET, phase: 'queued', connection: 'direct', position: 2 },
  })
  // Nothing is committed while the other computer is still getting ready.
  expect(f.store.kvGet(CORE, 'mode')).toBe('cloud')
  expect(pins(f.store).model).toBe('cloud/previous')
  ready()
  expect(await settle(f.controller)).toMatchObject({
    phase: 'ready', target: TARGET, targetStatus: { phase: 'loading' },
    selectedModel: { id: `@${HOST}/llama/x`, name: 'Model X' }, message: 'Local · Model X · Workstation',
  })
  expect(f.controller.status()?.picker).toBeUndefined()
  expect(f.order).toEqual(['stop', 'select'])
  expect(f.select).toHaveBeenCalledExactlyOnceWith(TARGET, expect.any(AbortSignal), expect.any(Function))
  expect(f.runners.loaded()).toBeUndefined()
  expect(f.runners.ensure).not.toHaveBeenCalled()
  expect(f.external).not.toHaveBeenCalled()
  expect(f.store.kvGet(CORE, 'mode')).toBe('local')
  expect(pins(f.store)).toMatchObject({ model: `@${HOST}/llama/x`, prefer: 'best', spend: 'free' })
  expect(pins(f.store).order).toBeUndefined()
  expect(selectedTarget(f.store)).toEqual(TARGET)
})

test.each([
  ['offline', 'That computer is offline.'],
  ['setup-required', 'That computer has not downloaded Model X.'],
  ['busy', 'That computer is busy.'],
  ['incompatible-version', 'That computer runs a different version of Alexia.'],
  ['worker-failure', 'That computer could not prepare the model.'],
] as const)('a paired computer that is %s ends the switch failed, with the picker, and loads nothing here instead', async (code, message) => {
  const f = fixture()
  // A model of the same name is installed here and would fit: it is not a fallback.
  f.install('x')
  f.install('other')
  const target = TARGET
  f.select.mockImplementationOnce(async (_target, _signal, onStatus) => {
    onStatus?.(status(target, 'connecting', 'Connecting to the paired computer.'))
    onStatus?.(status(target, code, message))
    throw new ComputeError(code, message)
  })
  const before = pins(f.store)
  f.controller.request('local', qualify(target))
  expect(await settle(f.controller)).toMatchObject({ phase: 'failed', picker: true, message, target, targetStatus: { phase: code, message } })
  expect(f.controller.status()?.selectedModel).toBeUndefined()
  expect(f.runners.ensure).not.toHaveBeenCalled()
  expect(f.runners.loaded()).toBeUndefined()
  // The search for a model on this computer never began.
  expect(f.probe).not.toHaveBeenCalled()
  expect(f.external).not.toHaveBeenCalled()
  expect(f.select).toHaveBeenCalledOnce()
  expect(f.store.kvGet(CORE, 'mode')).toBe('cloud')
  expect(pins(f.store)).toEqual(before)
  expect(f.store.kvGet(CORE, TARGET_KEY)).toBeUndefined()
})

test('with no paired-computer support, a remote selection fails with the picker rather than finding a model here', async () => {
  const f = fixture({ remote: false })
  f.install('x')
  f.controller.request('local', qualify(TARGET))
  expect(await settle(f.controller)).toMatchObject({ phase: 'failed', picker: true, target: TARGET })
  expect(f.runners.ensure).not.toHaveBeenCalled()
  expect(f.runners.stop).not.toHaveBeenCalled()
  expect(f.store.kvGet(CORE, 'mode')).toBe('cloud')
})

test('the selected paired computer is remembered through Cloud and a restart, and is never swapped for a model here', async () => {
  const f = fixture()
  f.install('x')
  // An older choice on this computer, which Local must not go back to by itself.
  setPin(f.store, { model: 'llama/x' })
  f.controller.request('local', qualify(TARGET))
  expect((await settle(f.controller)).message).toBe('Local · Model X · Paired computer')
  expect(f.deselect).not.toHaveBeenCalled()

  f.controller.request('cloud')
  expect((await settle(f.controller)).phase).toBe('ready')
  expect(f.deselect).toHaveBeenCalledOnce()
  expect(pins(f.store).model).toBeUndefined()
  expect(selectedTarget(f.store)).toEqual(TARGET)
  expect(f.store.kvGet(CORE, 'last_local_model')).toBe('llama/x')

  f.controller.request('local')
  expect(await settle(f.controller)).toMatchObject({ phase: 'ready', target: TARGET, selectedModel: { id: `@${HOST}/llama/x` } })
  expect(f.select).toHaveBeenCalledTimes(2)
  expect(f.runners.ensure).not.toHaveBeenCalled()

  // And when that computer is gone on the way back, it is a failure, not this computer's model.
  f.controller.request('cloud')
  await settle(f.controller)
  f.select.mockRejectedValueOnce(new ComputeError('offline', 'That computer is offline.'))
  f.controller.request('local')
  expect(await settle(f.controller)).toMatchObject({ phase: 'failed', picker: true, message: 'That computer is offline.' })
  expect(f.runners.ensure).not.toHaveBeenCalled()
  expect(f.store.kvGet(CORE, 'mode')).toBe('cloud')
})

test('choosing a model on this computer leaves the paired one', async () => {
  const f = fixture()
  const here = f.install('x')
  f.controller.request('local', qualify(TARGET))
  await settle(f.controller)
  f.order.length = 0
  f.controller.request('local', here.id)
  expect(await settle(f.controller)).toMatchObject({ phase: 'ready', selectedModel: { id: 'llama/x' }, target: { hostId: 'this', modelId: 'llama/x' }, message: 'Local · x' })
  expect(f.controller.status()?.targetStatus).toBeUndefined()
  expect(f.order).toEqual(['stop', 'deselect', 'ensure'])
  expect(pins(f.store).model).toBe('llama/x')
  expect(selectedTarget(f.store)).toEqual({ hostId: 'this', modelId: 'llama/x' })
})

test('an unpaired target opens the picker, and does not pick another model', async () => {
  const f = fixture()
  f.install('x')
  f.store.kvSet(CORE, 'last_local_model', 'llama/x')
  // What unpairing the selected host leaves behind (`compute/hosts.ts`).
  f.store.kvSet(CORE, TARGET_KEY, null)
  f.controller.request('local')
  expect(await settle(f.controller)).toMatchObject({ phase: 'failed', picker: true })
  expect(f.runners.ensure).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
  // Choosing one is still a choice.
  f.controller.request('local', 'llama/x')
  expect(await settle(f.controller)).toMatchObject({ phase: 'ready', selectedModel: { id: 'llama/x' } })
})

test('a store from before paired computers is migrated when the mode controller starts', () => {
  const f = fixture()
  const store = new Store(':memory:')
  try {
    store.kvSet(CORE, 'last_local_model', 'llama/x')
    const controller = new ModeTransitions({ store, dataDir: tmpdir(), runners: f.runners, busy: () => false })
    expect(store.kvGet(CORE, TARGET_KEY)).toEqual({ hostId: 'this', modelId: 'llama/x' })
    expect(store.kvGet(CORE, 'last_local_model')).toBe('llama/x')
    void controller.close()
  } finally { store.close() }
})
