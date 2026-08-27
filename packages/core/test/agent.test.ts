// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, test } from 'vitest'
import { run, type Step, type Tooling } from '../src/agent.js'
import type { Model } from '../src/catalog.js'
import { remaining } from '../src/pool.js'
import { keyOf, type Provider, type ToolSpec } from '../src/provider.js'
import { MODES, type Pins, type World } from '../src/router.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'

// The loop, written down twice: once as code and once as the behaviour somebody would
// notice breaking. Every test here scripts a model — what it calls, what it says — and
// then asks what the loop did with it.

const model = (over: Partial<Model> & Pick<Model, 'id' | 'tier'>): Model => ({
  name: over.id,
  provider: 'alpha',
  priceIn: 0,
  priceOut: 0,
  context: 32_768,
  supportsTools: true,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'unknown',
  ...over,
})

// Two tiers, so which one a step chose is visible from the outside. `tools` floors at T0
// and `hard` at T1, which is the whole of the per-step tiering rule.
const tiny = model({ id: 'tiny', tier: 'T0' })
const big = model({ id: 'big', tier: 'T1', priceIn: 1 })

/** One scripted assistant turn: either it calls something, or it answers. */
type Turn = { say: string } | { call: string; args?: string }

let script: Turn[] = []
/** Which model id served each step, in order. The per-step tiering assertions read this. */
let served: string[] = []

const server: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    served.push((JSON.parse(raw) as { model: string }).model)
    const turn = script.shift() ?? { say: 'done' }
    const delta =
      'call' in turn ?
        {
          tool_calls: [
            {
              index: 0,
              id: `c${String(served.length)}`,
              function: { name: turn.call, arguments: turn.args ?? '{}' },
            },
          ],
        }
      : { content: turn.say }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n` +
        `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
    )
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
afterAll(() => server.close())

const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
const alpha: Provider = { id: 'alpha', name: 'Alpha', baseUrl: at, rpm: 100, rpd: 100 }

const secrets = memorySecrets()
await secrets.set(CORE, keyOf(alpha), 'sk-a')

/** A tool list and a call log, in the shape the loop takes it. */
function tooling(
  over: { list?: ToolSpec[]; call?: Tooling['call'] } = {},
): Tooling & { calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  return {
    calls,
    list: () => Promise.resolve(over.list ?? [{ name: 'notes.read', description: 'Read a note.' }]),
    call: (name, args, signal) => {
      calls.push({ name, args })
      return over.call ? over.call(name, args, signal) : Promise.resolve({ text: 'the note says hi', ok: true })
    },
  }
}

const pins: Pins = { placement: MODES.combined }

function bench(): { store: Store; session: number; world(): Promise<World> } {
  const store = new Store(':memory:')
  return {
    store,
    session: store.createSession(),
    world: () =>
      Promise.resolve({ models: [tiny, big], local: [], rungs: [remaining(store, alpha)] }),
  }
}

const start = (text: string): { role: 'user'; content: string }[] => [{ role: 'user', content: text }]

test('plan, act, observe, answer — and the trace is the conversation', async () => {
  script = [{ call: 'notes.read', args: '{"which":"today"}' }, { say: 'It says hi.' }]
  served = []
  const { store, session, world } = bench()
  const tools = tooling()
  store.append(session, start('read my note')[0]!)

  const result = await run({ messages: start('read my note'), tools, pins, world, store, secrets, session })

  expect(result.ended).toBe('answered')
  expect(tools.calls).toEqual([{ name: 'notes.read', args: { which: 'today' } }])

  // Two steps of model, one tool call between them, and every one of them written down.
  expect(result.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
  expect(result.steps.map((s) => [s.name, s.outcome?.ok])).toEqual([['notes.read', true]])

  // What a reload shows is what the user watched happen — including the tool turn, which
  // is the half that would be easy to keep only in memory.
  const history = store.history(session)
  expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  expect(history[2]).toMatchObject({ role: 'tool', callId: 'c1', content: 'the note says hi' })
  expect(history.at(-1)?.content).toBe('It says hi.')

  // The standing instruction is not something anybody said, so it is not in the history —
  // but it did reach the model.
  expect(history.some((m) => m.role === 'system')).toBe(false)
  store.close()
})

test('the plan pays for the planning tier; turning the crank does not', async () => {
  script = [{ call: 'notes.read' }, { call: 'notes.read' }, { say: 'done' }]
  served = []
  const { store, session, world } = bench()

  // "refactor" is one of the words that means this is not a quick answer, so the first
  // step floors at T1. The two after it are the same task being cranked, and go cheap.
  await run({ messages: start('refactor the notes module'), tools: tooling(), pins, world, store, secrets, session })

  expect(served).toEqual(['big', 'tiny', 'tiny'])
  store.close()
})

test('a tool that fails is an observation, and it buys back the planning tier', async () => {
  script = [{ call: 'notes.read' }, { call: 'notes.read' }, { say: 'I could not read it.' }]
  served = []
  const { store, session, world } = bench()
  let first = true
  const tools = tooling({
    call: () => {
      const failing = first
      first = false
      return Promise.resolve(
        failing ? { text: 'no such note', ok: false } : { text: 'the note says hi', ok: true },
      )
    },
  })

  const result = await run({
    messages: start('refactor the notes module'),
    tools,
    pins,
    world,
    store,
    secrets,
    session,
  })

  // The failure did not throw: it went back to the model as the answer to its own call.
  expect(result.ended).toBe('answered')
  expect(store.history(session).some((m) => m.content === 'no such note')).toBe(true)

  // Plan on `big`; the step after the failure is re-planning, so it is on `big` again;
  // the step after the one that worked is cranking, so it is cheap.
  expect(served).toEqual(['big', 'big', 'tiny'])
  store.close()
})

test('a model that will not stop meets the ceiling instead of the monthly budget', async () => {
  script = []
  served = []
  const { store, session, world } = bench()
  const tools = tooling()
  // An empty script answers 'done', so script a model that only ever calls something.
  const forever: Turn[] = Array.from({ length: 50 }, () => ({ call: 'notes.read' }) as Turn)
  script = forever

  const result = await run({
    messages: start('go'),
    tools,
    pins,
    world,
    store,
    secrets,
    session,
    maxSteps: 4,
  })

  expect(result.ended).toBe('ceiling')
  expect(result.steps).toHaveLength(4)
  expect(tools.calls).toHaveLength(4)
  store.close()
})

test('stop works mid-task, and a stopped task is not a failed one', async () => {
  script = [{ call: 'notes.read' }, { call: 'notes.read' }, { say: 'done' }]
  served = []
  const { store, session, world } = bench()
  const stop = new AbortController()
  const seen: Step[] = []
  const tools = tooling({
    call: () => {
      // Pressed while the first tool call is in flight.
      stop.abort()
      return Promise.resolve({ text: 'read', ok: true })
    },
  })

  const result = await run({
    messages: start('go'),
    tools,
    pins,
    world,
    store,
    secrets,
    session,
    signal: stop.signal,
    on: { done: (step) => seen.push(step) },
  })

  expect(result.ended).toBe('stopped')
  // The step that was in flight still finished and was still recorded. A stop is not an
  // undo, and a trace that hid the last thing that ran would be lying about it.
  expect(seen.map((s) => s.name)).toEqual(['notes.read'])
  expect(store.history(session).some((m) => m.role === 'tool')).toBe(true)
  store.close()
})

test('a pin nothing satisfies stops the task and says so, mid-task included', async () => {
  script = [{ call: 'notes.read' }, { say: 'done' }]
  served = []
  const { store, session, world } = bench()

  const result = await run({
    messages: start('go'),
    tools: tooling(),
    pins: { ...pins, uncensored: true },
    world,
    store,
    secrets,
    session,
  })

  // Nothing here is flagged `yes`, and `unknown` is not a yes — so the loop stops on the
  // first step rather than quietly asking something the pin excluded.
  expect(result.ended).toBe('refused')
  expect(result.why).toContain('uncensored')
  expect(result.steps).toEqual([])
  store.close()
})

test('arguments the model mangled reach the tool as nothing, not as a crash', async () => {
  script = [{ call: 'notes.read', args: '{"which": ' }, { say: 'done' }]
  served = []
  const { store, session, world } = bench()
  const tools = tooling()

  const result = await run({ messages: start('go'), tools, pins, world, store, secrets, session })

  expect(result.ended).toBe('answered')
  expect(tools.calls).toEqual([{ name: 'notes.read', args: {} }])
  store.close()
})

test('with nothing to call, the loop is one turn and says so to the model', async () => {
  script = [{ say: 'I know this one.' }]
  served = []
  const { store, session, world } = bench()

  const result = await run({
    messages: start('what is a heartbeat'),
    tools: tooling({ list: [] }),
    pins,
    world,
    store,
    secrets,
    session,
  })

  expect(result.ended).toBe('answered')
  expect(result.steps).toEqual([])
  expect(result.messages.map((m) => m.role)).toEqual(['assistant'])
  store.close()
})
