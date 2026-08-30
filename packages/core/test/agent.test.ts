// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, test } from 'vitest'
import { run, struggling, type MoneyConsent, type Step, type Tooling } from '../src/agent.js'
import type { Model } from '../src/catalog.js'
import { remaining } from '../src/pool.js'
import { keyOf, type Provider, type ToolSpec } from '../src/provider.js'
import { OLLAMA } from '../src/ollama.js'
import { MODES, type Pins, type World } from '../src/router.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import type { Message } from '../src/store.js'
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

// The hosted pair, for the tests that are not about tiering.
const tiny = model({ id: 'tiny', tier: 'T0' })
const hosted = model({ id: 'hosted', tier: 'T1', priceIn: 1 })

/** One scripted assistant turn: either it calls something, or it answers. */
type Turn = { say: string } | { call: string; args?: string }

let script: Turn[] = []
/** Which model id served each step, in order. The per-step tiering assertions read this. */
let served: string[] = []
/** The last request as the provider received it. What the model was *shown*, not what we meant. */
let body: { model: string; messages: { role: string; content: string }[] } | undefined
/** The standing instruction as it went on the wire. A function, so a reset does not narrow it away. */
const systemLine = (): string => body?.messages.find((m) => m.role === 'system')?.content ?? ''
/** How many tool turns the last request showed the model. A function, for the same reason. */
const shownTurns = (): number => body?.messages.filter((m) => m.role === 'tool').length ?? 0

const server: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    body = JSON.parse(raw) as { model: string; messages: { role: string; content: string }[] }
    served.push(body.model)
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

// Local placement always routes to OLLAMA, whose base URL is fixed on purpose — it runs on
// this machine or it does not. Pointing it at the scripted server is the only seam there is,
// and vitest gives each test file its own module instance, so it stays in this file.
OLLAMA.baseUrl = at
OLLAMA.auth = 'none'

/** Two local models, same tier and both free: only their size tells them apart. */
const small = model({ id: 'small', tier: 'T0', provider: 'ollama', params: 1 })
const big = model({ id: 'big', tier: 'T0', provider: 'ollama', params: 8 })
const local = (): Promise<World> => Promise.resolve({ models: [], local: [small, big], rungs: [] })

function bench(): { store: Store; session: number; world(): Promise<World> } {
  const store = new Store(':memory:')
  return {
    store,
    session: store.createSession(),
    world: () =>
      Promise.resolve({ models: [tiny, hosted], local: [], rungs: [remaining(store, alpha)] }),
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

test('the plan pays for a model that can plan; turning the crank does not', async () => {
  // Two different notes: the same call with the same arguments twice is the looping signal,
  // and this test is about which model turns the crank, not about struggling.
  script = [
    { call: 'notes.read', args: '{"which":"today"}' },
    { call: 'notes.read', args: '{"which":"yesterday"}' },
    { say: 'done' },
  ]
  served = []
  const { store, session } = bench()

  // "refactor" is one of the words that means this is not a quick answer, so step one is a
  // planning step. The two after it are the same plan being cranked.
  await run({
    messages: start('refactor the notes module'),
    tools: tooling(),
    pins: { placement: MODES.local },
    world: local,
    store,
    secrets,
    session,
  })

  // Planning skips the 1B — G5 measured an 8B, and said nothing good about anything below
  // it. Cranking does not need a planner, so it takes the first free model that can call a
  // tool, which is the small one.
  expect(served).toEqual(['big', 'small', 'small'])
  store.close()
})

test('a tool that fails is an observation, and it buys back the planner', async () => {
  script = [
    { call: 'notes.read', args: '{"which":"today"}' },
    { call: 'notes.read', args: '{"which":"yesterday"}' },
    { say: 'I could not read it.' },
  ]
  served = []
  const { store, session } = bench()
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
    pins: { placement: MODES.local },
    world: local,
    store,
    secrets,
    session,
  })

  // The failure did not throw: it went back to the model as the answer to its own call.
  expect(result.ended).toBe('answered')
  expect(store.history(session).some((m) => m.content === 'no such note')).toBe(true)

  // Plan on the 8B; the step after the failure is re-planning, so it is on the 8B again;
  // the step after the one that worked is cranking, so it is on the 1B.
  expect(served).toEqual(['big', 'big', 'small'])
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

test('a personality reaches the model, and only ever after Alexia’s own instruction', async () => {
  /**
   * The test M4-4 shipped without, and the reason it needed one.
   *
   * The first personality node rewrote the *finished answer* instead, which meant every
   * behavioural line in a real personality — *ask before anything with external
   * consequence* — was inert by construction. It was replaced by this path, and nothing
   * asserted the paragraph actually arrives: it is built in `system()`, handed to `send`,
   * and mapped by `toWire`, and a break anywhere along there looks exactly like a model
   * choosing to ignore it.
   */
  script = [{ say: 'Noted.' }]
  served = []
  body = undefined
  const { store, session, world } = bench()

  await run({
    messages: start('hey'),
    tools: tooling({ list: [] }),
    pins,
    world,
    store,
    secrets,
    session,
    personality: '# Chief of staff\n\nCall him Vacen. No emojis.',
  })

  const system = systemLine()
  expect(system).toContain('Call him Vacen. No emojis.')
  // After, never instead of. The four standing lines are the floor a model needs to drive
  // the loop at all, and a personality that could replace them could turn the loop off.
  expect(system.indexOf('You are Alexia')).toBeLessThan(system.indexOf('Chief of staff'))

  // And with none chosen, the system line is exactly what it always was — the default is
  // what most conversations get, so it is the half most worth pinning down.
  script = [{ say: 'Noted.' }]
  body = undefined
  await run({ messages: start('hey'), tools: tooling({ list: [] }), pins, world, store, secrets, session })
  expect(systemLine()).toContain('You are Alexia')
  expect(systemLine()).not.toContain('Vacen')
  store.close()
})

test('the trace is trimmed to the window that won, not to a number picked in advance', async () => {
  // A long task already behind it, and one more step to take. What the model is *shown* is
  // decided after the routing, because the budget is a property of the model rather than of
  // the trace — a fixed number is either too big for the small rung at the bottom or leaves
  // most of a wide window unused.
  // Two hundred *different* notes: the same note read twice is the mechanical collapse's
  // business (§11.3), and this test is about the window rather than about repetition.
  const history: Message[] = Array.from({ length: 200 }, (_, i) => [
    {
      role: 'assistant' as const,
      content: '',
      calls: [{ id: `h${String(i)}`, name: 'notes.read', arguments: `{"which":"note-${String(i)}"}` }],
    },
    { role: 'tool' as const, callId: `h${String(i)}`, content: `note ${String(i)}: ${'detail '.repeat(40)}` },
  ]).flat()

  const shownTo = async (context: number): Promise<number> => {
    script = [{ say: 'done' }]
    served = []
    body = undefined
    const { store, session } = bench()
    const only = model({ id: `window-${String(context)}`, tier: 'T1', context })
    await run({
      messages: [...start('tidy the notes folder'), ...history],
      tools: tooling(),
      pins,
      world: () => Promise.resolve({ models: [only], local: [], rungs: [remaining(store, alpha)] }),
      store,
      secrets,
      session,
    })
    store.close()
    return shownTurns()
  }

  const wide = await shownTo(200_000)
  const narrow = await shownTo(32_768)

  // The same trace, the same step, two different windows — and the wide one gets to keep
  // more of the work verbatim instead of as a line about the work.
  expect(wide).toBeGreaterThan(narrow)
  expect(narrow).toBeGreaterThanOrEqual(1)
})

/**
 * **The mid-task rule** (§8.5), which the plan calls non-negotiable.
 *
 * A helper with hands on step one, and by step two every rung that can call a tool is gone.
 * The one thing that must not happen is the quiet continuation: a talker cannot pick up what
 * the last model put down, and a task finished by one is a task stranded half-done while
 * looking, from the outside, like the assistant simply got worse.
 */
test('a task that runs out of hands stops, and says that is what happened', async () => {
  script = [{ call: 'notes.read' }, { say: 'done' }]
  served = []
  const { store, session } = bench()
  const talker = model({ id: 'chat/only', tier: 'T1', supportsTools: false })
  const handy = model({ id: 'has/hands', tier: 'T1' })

  // The world is asked fresh every step, which is the seam: hands on the first, gone on the
  // second. A free tier reaching its daily limit halfway through a job looks exactly like it.
  let step = 0
  const result = await run({
    messages: start('read my note'),
    tools: tooling(),
    pins,
    world: () =>
      Promise.resolve({
        models: step++ === 0 ? [handy, talker] : [talker],
        local: [],
        rungs: [remaining(store, alpha)],
      }),
    store,
    secrets,
    session,
  })

  // One step happened, on the model that had hands, and then it stopped. `chat/only` was
  // sitting right there, able to answer, and was never asked — which is the whole rule.
  expect(served).toEqual(['has/hands'])
  expect(result.steps).toHaveLength(1)
  expect(result.ended).toBe('refused')
  expect(result.why).toContain('ran out of helpers with hands')
  store.close()
})

test('on the first message the wall is named by its fix, not by the loss', async () => {
  // Nothing is half-done before the first step, so §8.5's sentence would be describing a
  // stranding that did not happen. The router's own sentence is the better one here: it says
  // what is missing rather than what was lost.
  script = [{ say: 'done' }]
  served = []
  const { store, session } = bench()
  const talker = model({ id: 'chat/only', tier: 'T1', supportsTools: false })

  const result = await run({
    messages: start('read my note'),
    tools: tooling(),
    pins,
    world: () => Promise.resolve({ models: [talker], local: [], rungs: [remaining(store, alpha)] }),
    store,
    secrets,
    session,
  })

  expect(served).toEqual([])
  expect(result.ended).toBe('refused')
  expect(result.why).toBe('none of the models available to you can use tools')
  store.close()
})

// The money question (§9.5). One question, in the one situation that is genuinely a choice —
// and a router that asks about money every request is a nag, which is worse than not asking
// because a nag is clicked through without being read.

/** Nothing free and keyed, one paid rung, and the model on this machine that heads the plan. */
const aChoice = (store: Store, allowance: number): World => ({
  models: [model({ id: 'paid/wide', tier: 'T2', priceIn: 1, context: 128_000 })],
  local: [model({ id: 'qwen3:8b', tier: 'T0', provider: 'ollama' })],
  rungs: [remaining(store, alpha)],
  today: { spent: 0.12, allowance },
})

/** A consent object of the shape the caller owns, plus a log of what it was asked. */
const consent = (answer: boolean): MoneyConsent & { asked: string[] } => {
  const asked: string[] = []
  return {
    asked,
    allowed: undefined,
    ask(question: string) {
      asked.push(question)
      return Promise.resolve(answer)
    },
  }
}

test('the money question is asked once in a task, not once a step', async () => {
  script = [{ call: 'notes.read' }, { call: 'notes.read' }, { say: 'done' }]
  served = []
  const { store, session } = bench()
  const money = consent(true)

  const result = await run({
    messages: start('read my note'),
    tools: tooling(),
    pins,
    world: () => Promise.resolve(aChoice(store, 1)),
    store,
    secrets,
    session,
    money,
  })

  expect(result.ended).toBe('answered')
  // Three steps, one question — and the number is in it, because *how much have I spent* is
  // the thing somebody needs to answer it. Yes bought the faster rung and every step went
  // there: asking for speed and being given the slow one anyway is the answer not being read.
  expect(served).toEqual(['paid/wide', 'paid/wide', 'paid/wide'])
  expect(money.asked).toHaveLength(1)
  expect(money.asked[0]).toBe(
    'Do you want slow local (free), or paid credits on Alpha? Spent $0.12 of $1.00 today.',
  )
  store.close()
})

test('saying no does not quietly spend the money anyway, and still answers', async () => {
  script = [{ say: 'done' }]
  served = []
  const { store, session } = bench()
  const money = consent(false)

  const result = await run({
    messages: start('read my note'),
    tools: tooling(),
    pins,
    world: () => Promise.resolve(aChoice(store, 1)),
    store,
    secrets,
    session,
    money,
  })

  // Asked, told no, and the plan stayed where it already was: the slow free rung on this
  // machine, which is what *no* means now that local is a rung of the cascade. Not a refusal
  // — a refusal was the old shape, from back when saying no left nothing underneath.
  expect(money.asked).toHaveLength(1)
  expect(result.ended).toBe('answered')
  expect(served).toEqual(['qwen3:8b'])
  expect(store.spend(0)).toBe(0)
  store.close()
})

test('with nothing allowed for today there is nothing to consent to, so nobody is asked', async () => {
  script = [{ say: 'done' }]
  served = []
  const { store, session } = bench()
  const money = consent(true)

  await run({
    messages: start('read my note'),
    tools: tooling(),
    pins,
    world: () => Promise.resolve(aChoice(store, 0)),
    store,
    secrets,
    session,
    money,
  })

  // No paid rung reached the plan, so there is nothing to consent to and the question never
  // appears — which is what keeps it worth reading on the day it does. The work still gets
  // done, on the machine it is running on, for nothing.
  expect(money.asked).toEqual([])
  expect(served).toEqual(['qwen3:8b'])
  store.close()
})

// Escalation (§10). **Measure struggle, do not predict difficulty**: nothing below reads a
// word the user typed. Every signal is read off steps that have already happened, which is
// the thing the request could not have told anybody at the top.

/** One step that went fine, distinct from every other one by both its call and its answer. */
const step = (n: number, over: Partial<Step> = {}): Step => ({
  n,
  name: 'notes.read',
  args: { which: `note-${String(n)}` },
  outcome: { text: `note ${String(n)}`, ok: true },
  ...over,
})

/** The same call, made again. `n` differs and the signature does not, which is the point. */
const again = (n: number): Step => step(n, { args: { which: 'today' } })
const failing = (n: number): Step => step(n, { outcome: { text: `no such note ${String(n)}`, ok: false } })
/** No money in play, and plenty of leash: the state the four work-shaped signals are read in. */
const calm = { ceiling: 100, budget: 0, spent: 0 }

test('the five struggle signals, each in the condition that is its own', () => {
  // Different calls, different answers, early in the leash, nothing spent. This is a task
  // that is going fine, and the whole mechanism has to be quiet for it.
  expect(struggling({ steps: [step(1), step(2), step(3)], ...calm })).toBeUndefined()

  // **Looping**: the same tool with the same arguments, twice. A string compare, exact
  // rather than heuristic, and it catches most of the *loops for hours* case on its own.
  expect(struggling({ steps: [again(1), step(2), again(3)], ...calm })).toBe('looping')

  // **Stuck**: one tool, three failures running. The arguments differ each time — what is
  // not working is the tool, and the model is trying to argue with it.
  expect(struggling({ steps: [step(1), failing(2), failing(3), failing(4)], ...calm })).toBe('stuck')

  // **Spinning**: three steps whose answers the loop had already been told. Different calls
  // returning identical text is exactly what the exact signal above cannot see.
  const told = [step(1), step(2), step(3)]
  const retold = [4, 5, 6].map((n) => step(n, { outcome: { text: `note ${String(n - 3)}`, ok: true } }))
  expect(struggling({ steps: [...told, ...retold], ...calm })).toBe('spinning')

  // **Grinding**: far enough into the leash that the leash is now the story. Free to detect,
  // because it is a length.
  expect(struggling({ steps: [step(1), step(2), step(3), step(4)], ceiling: 10, budget: 0, spent: 0 })).toBe(
    'grinding',
  )

  // **Expensive**: 40% of what the task had, with nothing finished (§10.5).
  expect(struggling({ steps: [step(1)], ceiling: 100, budget: 1, spent: 0.4 })).toBe('expensive')

  // A task with no allowance behind it has not spent 40% of nothing — it has nothing to
  // escalate into, which is silence rather than a signal that has already fired.
  expect(struggling({ steps: [step(1)], ceiling: 100, budget: 0, spent: 5 })).toBeUndefined()
})

/** The lines core said to the user while a run happened, in the shape the loop takes them. */
function watched(): { notes: string[]; on: { note(line: string): void } } {
  const notes: string[] = []
  return { notes, on: { note: (line: string) => notes.push(line) } }
}

/** The same call twice, then a different one, then an answer. Steps one and two are the signal. */
const repeating: Turn[] = [
  { call: 'notes.read', args: '{"which":"today"}' },
  { call: 'notes.read', args: '{"which":"today"}' },
  { call: 'notes.read', args: '{"which":"tomorrow"}' },
  { say: 'done' },
]

test('a loop repeating itself escalates on its own, and only the next plan is spent on it', async () => {
  script = [...repeating]
  served = []
  const { store, session } = bench()
  const seen = watched()

  const result = await run({
    messages: start('refactor the notes module'),
    tools: tooling(),
    pins,
    // The machine heads the plan and there is an allowance behind it — the shape §10 is
    // about, where climbing a rung is possible and nobody has been asked to click anything.
    world: () => Promise.resolve(aChoice(store, 1)),
    store,
    secrets,
    session,
    on: seen.on,
  })

  expect(result.ended).toBe('answered')
  // Nobody was asked and nothing restarted: the third turn is the next plan, and it is the
  // one that goes to the better model. The turn after it is mechanical again, so it drops
  // back — escalating the planning step is the point, escalating every step is the waste.
  expect(served).toEqual(['qwen3:8b', 'qwen3:8b', 'paid/wide', 'qwen3:8b'])
  // Both halves of it said out loud, in order: why the model changed, and then — because the
  // rung it changed to charges — what that costs. The second line is not new; it is what
  // every paid turn already says, and escalation does not get to say it more quietly.
  expect(seen.notes).toEqual([
    'That call has come back twice with the same arguments, so the next plan goes to a better model.',
    'Using paid/wide, which costs money — about $1.00 per million words in.',
  ])
  store.close()
})

test('40% of the purse gone with nothing finished spends the rest on a better model', async () => {
  // Two different notes and two different answers: nothing here is looping, stuck, spinning
  // or grinding. The only thing wrong with this task is what it has cost.
  script = [
    { call: 'notes.read', args: '{"which":"today"}' },
    { call: 'notes.read', args: '{"which":"tomorrow"}' },
    { say: 'done' },
  ]
  served = []
  const { store, session } = bench()
  const seen = watched()
  let spent = 0
  const burning = (): Promise<World> => {
    const today = { spent, allowance: 1 }
    // Every turn of this task takes a quarter of what the day had when it opened.
    spent += 0.25
    return Promise.resolve({ ...aChoice(store, 1), today })
  }

  const result = await run({
    messages: start('refactor the notes module'),
    tools: tooling(),
    pins,
    world: burning,
    store,
    secrets,
    session,
    on: seen.on,
  })

  // The cap is a doorway, not a wall (§10.5): the cheap rung spent 40% proving it could not
  // finish, and the rest goes on one attempt with something better. Same budget, opposite
  // outcome — the waste becomes the signal.
  expect(result.ended).toBe('answered')
  expect(served).toEqual(['qwen3:8b', 'qwen3:8b', 'paid/wide'])
  expect(seen.notes).toEqual([
    'This has spent much of what the task had and is not finished, so the rest goes on one attempt with a better model.',
    'Using paid/wide, which costs money — about $1.00 per million words in.',
  ])
  store.close()
})

test('escalation never buys what the allowance did not', async () => {
  script = [...repeating]
  served = []
  const { store, session } = bench()
  const seen = watched()

  const result = await run({
    messages: start('refactor the notes module'),
    tools: tooling(),
    pins,
    // The same task, on the day nobody set an allowance. The only rung above the machine
    // charges for it, so there is no rung above the machine.
    world: () => Promise.resolve(aChoice(store, 0)),
    store,
    secrets,
    session,
    on: seen.on,
  })

  // The loop saw the same repeated call it saw before and then found nothing it was allowed
  // to escalate into, so the work carries on where it was — unbilled, and unpromised. A pin
  // with nothing behind it changes nothing, and says nothing either.
  expect(result.ended).toBe('answered')
  expect(served).toEqual(['qwen3:8b', 'qwen3:8b', 'qwen3:8b', 'qwen3:8b'])
  expect(seen.notes).toEqual([])
  expect(store.spend(0)).toBe(0)
  store.close()
})

test('a no to the money question is a no to the upgrade as well', async () => {
  script = [...repeating]
  served = []
  const { store, session } = bench()
  const seen = watched()
  const money = consent(false)

  const result = await run({
    messages: start('refactor the notes module'),
    tools: tooling(),
    pins,
    world: () => Promise.resolve(aChoice(store, 1)),
    store,
    secrets,
    session,
    money,
    on: seen.on,
  })

  // Asked once, told no — and then the loop struggled, which is exactly the moment the
  // answer has to still mean something. An upgrade that spends anyway is the question not
  // having been asked.
  expect(result.ended).toBe('answered')
  expect(money.asked).toHaveLength(1)
  expect(served).toEqual(['qwen3:8b', 'qwen3:8b', 'qwen3:8b', 'qwen3:8b'])
  expect(seen.notes).toEqual([])
  expect(store.spend(0)).toBe(0)
  store.close()
})
