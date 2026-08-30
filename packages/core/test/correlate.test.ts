// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, test } from 'vitest'
import { run, type Tooling } from '../src/agent.js'
import type { Model } from '../src/catalog.js'
import { remaining } from '../src/pool.js'
import { keyOf, type Provider } from '../src/provider.js'
import { MODES, type Pins, type World } from '../src/router.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'
import { asText, spentOn, Trace } from '../src/trace.js'

/**
 * M7-2. One id, four records.
 *
 * The pieces were all built and none of them touched: `trace.ts` kept runs with an `id`, and
 * `usage` recorded a `session_id`. **A session is not a run** — ten tasks in one sitting
 * share one — so the ledger could say what today cost and could not say what *that* cost,
 * which is the question anybody actually has.
 *
 * The acceptance, in three: the trace and the ledger reached by one id and agreeing, a 429
 * fallback with both model names against the charge it explains, and the honest answer where
 * there is nothing to join.
 */

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

const free = model({ id: 'free/text', tier: 'T1' })
// Paid, so a fallback to it is a charge somebody would notice and come here to explain.
// Four times the window of the free one, so it is a genuine step up rather than the same
// answer for money — which the router refuses to buy on the automatic path.
const paid = model({ id: 'paid/small', tier: 'T2', priceIn: 300, provider: 'beta', context: 128_000 })

/** Model ids the scripted server refuses with a 429, which is the next rung's turn. */
let refuse = new Set<string>()
let script: ({ say: string } | { call: string })[] = []

const server: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const asked = (JSON.parse(raw) as { model: string }).model
    if (refuse.has(asked)) {
      response.writeHead(429, { 'content-type': 'text/plain' })
      response.end('slow down')
      return
    }
    const turn = script.shift() ?? { say: 'done' }
    const delta =
      'call' in turn ?
        { tool_calls: [{ index: 0, id: 'c1', function: { name: turn.call, arguments: '{}' } }] }
      : { content: turn.say }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n` +
        `data: ${JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 100 } })}\n\ndata: [DONE]\n\n`,
    )
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
afterAll(() => server.close())

const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
const alpha: Provider = { id: 'alpha', name: 'Alpha', baseUrl: at, rpm: 100, rpd: 100 }
const beta: Provider = { id: 'beta', name: 'Beta', baseUrl: at, rpm: 100, rpd: 100 }

const secrets = memorySecrets()
await secrets.set(CORE, keyOf(alpha), 'sk-a')
await secrets.set(CORE, keyOf(beta), 'sk-b')

const pins: Pins = { placement: MODES.combined }
/**
 * `/best`, so the router reaches for the dear model first and the charges are real numbers
 * rather than the zeroes a free tier makes everything. A ledger test against $0.00 would
 * pass whether or not anything was joined.
 */
const dear: Pins = { placement: MODES.combined, prefer: 'best' }
const tools: Tooling = {
  list: () => Promise.resolve([{ name: 'notes.read', description: 'Read a note.' }]),
  call: () => Promise.resolve({ text: 'the note says hi', ok: true }),
}

function bench(): { store: Store; session: number; world(): Promise<World> } {
  const store = new Store(':memory:')
  return {
    store,
    session: store.createSession(),
    world: () =>
      Promise.resolve({
        models: [free, paid],
        local: [],
        rungs: [remaining(store, alpha), remaining(store, beta)],
        // These are about what the ledger writes down when money is spent, so there has to
        // be an allowance for it to be spent out of.
        today: { spent: 0, allowance: 1 },
      }),
  }
}

const start = (text: string): { role: 'user'; content: string }[] => [{ role: 'user', content: text }]

test('a run and what it spent are the same id, and they agree', async () => {
  refuse = new Set()
  script = [{ call: 'notes.read' }, { call: 'notes.read' }, { say: 'It says hi.' }]
  const { store, session, world } = bench()
  const trace = new Trace()

  // Two tasks in one session, which is the case a `session_id` cannot tell apart and is the
  // whole reason this column exists.
  const first = 'run-one'
  trace.start(first, 'read my note')
  await run({
    messages: start('read my note'),
    tools,
    pins: dear,
    world,
    store,
    secrets,
    session,
    run: first,
    on: { step: (step) => trace.step(step), done: (step) => trace.done(step) },
  })
  trace.end('answered', { calls: store.callsIn(first) })

  script = [{ say: 'Nothing to do.' }]
  const second = 'run-two'
  trace.start(second, 'and again')
  await run({ messages: start('and again'), tools, pins: dear, world, store, secrets, session, run: second })
  trace.end('answered', { calls: store.callsIn(second) })

  // Three model calls in the first, one in the second — and the ledger can now say so.
  expect(store.callsIn(first)).toHaveLength(3)
  expect(store.callsIn(second)).toHaveLength(1)

  // The two together are the session's total, which is the number that used to be the only
  // one available. Nothing was lost; something was added underneath it.
  const total = store.spend(0, { session })
  expect(total).toBeGreaterThan(0)
  expect(spentOn(trace.one(first)!) + spentOn(trace.one(second)!)).toBeCloseTo(total)
  // And the two runs are not the same number, which is the thing a session total cannot say.
  expect(spentOn(trace.one(first)!)).not.toBeCloseTo(spentOn(trace.one(second)!))

  // And a run reached by its id has a trace and a cost that came from the same place.
  const run1 = trace.one(first)!
  expect(run1.steps).toHaveLength(2)
  expect(spentOn(run1)).toBeCloseTo(store.callsIn(first).reduce((total, c) => total + c.cost, 0))
})

test('a fallback on 429 puts both model names against the cost', async () => {
  // The free rung refuses, so the turn goes to the paid one — the case where a cost is
  // surprising, and the only place it can be explained.
  refuse = new Set(['free/text'])
  script = [{ say: 'Answered by the dear one.' }]
  const { store, session, world } = bench()
  const trace = new Trace()

  const id = 'run-fallback'
  trace.start(id, 'something expensive')
  await run({ messages: start('something expensive'), tools, pins, world, store, secrets, session, run: id })
  trace.end('answered', { calls: store.callsIn(id) })

  const [charge] = store.callsIn(id)
  expect(charge?.asked).toBe('free/text')
  expect(charge?.model).toBe('paid/small')
  expect(charge?.cost).toBeGreaterThan(0)

  // What a person reads. Both names on the line that carries the number, because the badge
  // above shows one model and this is the one place the difference is explicable.
  const text = asText(trace.one(id)!)
  expect(text).toContain('asked free/text, answered paid/small — fell back')
  expect(text).toContain(`$${charge!.cost.toFixed(4)}`)
})

test('a charge with no run says so rather than reading as free', async () => {
  refuse = new Set()
  script = [{ say: 'done' }]
  const { store, session, world } = bench()
  // A model call made outside any run — no `run` was passed, so the row carries a null.
  await run({ messages: start('hello'), tools, pins: dear, world, store, secrets, session })

  // The spend happened — it just belongs to no run, which is the honest answer for the
  // checker asking outside a task, or a distillation somebody said yes to afterwards.
  expect(store.spend(0, { session })).toBeGreaterThan(0)
  expect(store.callsIn('never-happened')).toEqual([])

  const trace = new Trace()
  trace.start('empty', 'a run with nothing behind it')
  trace.end('refused', { why: 'no model fits this request right now', calls: store.callsIn('empty') })
  expect(asText(trace.one('empty')!)).toContain('no model call was recorded against this run')
})
