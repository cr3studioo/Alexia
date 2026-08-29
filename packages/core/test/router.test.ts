// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, test } from 'vitest'
import type { Model } from '../src/catalog.js'
import { remaining, sent } from '../src/pool.js'
import { keyOf, type Provider } from '../src/provider.js'
import { MODES, route, send, shapeOf, type Pins, type World } from '../src/router.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'

// The router is rules, so these are the rules written down twice — once as code and once
// as the behaviour somebody would notice breaking.

const model = (over: Partial<Model> & Pick<Model, 'id' | 'tier'>): Model => ({
  name: over.id,
  provider: 'alpha',
  priceIn: 0,
  priceOut: 0,
  context: 32_768,
  supportsTools: false,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'unknown',
  ...over,
})

const alpha: Provider = { id: 'alpha', name: 'Alpha', baseUrl: 'http://127.0.0.1:1', rpm: 10, rpd: 10 }
const beta: Provider = { id: 'beta', name: 'Beta', baseUrl: 'http://127.0.0.1:2', rpm: 10, rpd: 10 }

const freeText = model({ id: 'free/text', tier: 'T1' })
const freeTools = model({ id: 'free/tools', tier: 'T1', supportsTools: true })
const cheapPaid = model({ id: 'paid/small', tier: 'T2', priceIn: 0.2, supportsTools: true, provider: 'beta' })
const frontier = model({ id: 'paid/frontier', tier: 'T3', priceIn: 5, supportsTools: true, provider: 'beta' })
const localSmall = model({ id: 'qwen3:8b', tier: 'T0', provider: 'ollama', supportsTools: true })

const noon = Date.UTC(2026, 7, 27, 12, 0, 0)
const store = new Store(':memory:')
const world = (over: Partial<World> = {}): World => ({
  models: [freeText, freeTools, cheapPaid, frontier],
  local: [localSmall],
  rungs: [remaining(store, alpha), remaining(store, beta)],
  ...over,
})

const pins = (over: Partial<Pins> = {}): Pins => ({ placement: MODES.combined, ...over })
const asked = (text: string) => [{ role: 'user' as const, content: text }]
const ids = (verdict: ReturnType<typeof route>): string[] =>
  verdict.ok ? verdict.choices.map((c) => c.model.id) : [verdict.why]

test('request shape decides how much model the work needs', () => {
  expect(shapeOf({ messages: asked('what is the capital of Norway') })).toBe('simple')
  expect(shapeOf({ messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] })).toBe('tools')
  expect(shapeOf({ messages: asked('refactor this into two functions') })).toBe('hard')
  expect(shapeOf({ messages: asked('```js\nconst x = 1\n```') })).toBe('hard')
})

test('the cheapest rung that can do the job, and nothing dearer', () => {
  expect(ids(route({ messages: asked('capital of Norway') }, pins(), world()))).toEqual([
    'free/text',
    'free/tools',
    'paid/small',
    'paid/frontier',
  ])

  // Tools narrow it to models that have them, still cheapest first.
  const withTools = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }
  expect(ids(route(withTools, pins(), world()))).toEqual(['free/tools', 'paid/small', 'paid/frontier'])

  // Hard reasoning stays off a small local model, and `/best` walks from the other end.
  expect(ids(route({ messages: asked('refactor this') }, pins({ prefer: 'best' }), world()))).toEqual([
    'paid/frontier',
    'paid/small',
    'free/tools',
    'free/text',
  ])
})

test('among free models, the tie breaks on what the world actually uses', () => {
  // The free tier is one enormous tie: every one of these is T1, zero in, zero out. Before
  // `weekly` was in the comparator the winner was whichever the catalog listed first, and
  // that is a property of a JSON feed rather than a judgement — found when a personality
  // reached the model intact and was ignored by the small model at the front of the list.
  const popular = model({ id: 'free/popular', tier: 'T1', supportsTools: true, weekly: 3_385_079 })
  const niche = model({ id: 'free/niche', tier: 'T1', supportsTools: true, weekly: 113 })
  const silent = model({ id: 'free/silent', tier: 'T1', supportsTools: true })
  const ask = { messages: asked('hello'), tools: [{ name: 'fs.list' }] }

  // Listed worst-first on purpose: the catalog's order must not be what decides it.
  const order = ids(route(ask, pins(), world({ models: [niche, silent, popular], local: [] })))
  expect(order).toEqual(['free/popular', 'free/niche', 'free/silent'])

  // A provider that publishes no figure is unknown rather than unused, and unknown loses to
  // known-good — the same way `nsfwOk: 'unknown'` does not satisfy an uncensored pin. It
  // never outranks price, though: silence is not a discount.
  const paid = model({ id: 'paid/known', tier: 'T2', priceIn: 0.2, supportsTools: true, weekly: 9_000_000 })
  expect(ids(route(ask, pins(), world({ models: [paid, silent], local: [] })))).toEqual([
    'free/silent',
    'paid/known',
  ])
})

test('a plugin floor and the try-again-smarter hatch both raise the bar', () => {
  const ask = { messages: asked('capital of Norway'), minTier: 'T2' as const }
  expect(ids(route(ask, pins(), world()))).toEqual(['paid/small', 'paid/frontier'])

  // The one-click escape hatch: everything at or below what just answered is out.
  const harder = { messages: asked('capital of Norway'), above: 'T2' as const }
  expect(ids(route(harder, pins(), world()))).toEqual(['paid/frontier'])
})

test('a pin is never violated quietly, and the refusal says what to do', () => {
  // Local placement means local. The hosted models are not a fallback, they are out.
  expect(ids(route({ messages: asked('hello') }, pins({ placement: MODES.local }), world()))).toEqual([
    'qwen3:8b',
  ])

  // The sentence the spec asks for, word for word in intent: what is missing, and what to type.
  const uncensored = pins({ placement: MODES.local, uncensored: true })
  expect(ids(route({ messages: asked('hello') }, uncensored, world()))).toEqual([
    'no local uncensored model is installed — install one, or type /cloud',
  ])

  // Nothing installed at all is its own sentence.
  const nothing = world({ local: [] })
  expect(ids(route({ messages: asked('hello') }, pins({ placement: MODES.local }), nothing))).toEqual([
    'no local model is installed — install one, or type /cloud',
  ])

  // And an unknown content policy is not a yes: this is a hosted model nobody has verified.
  expect(ids(route({ messages: asked('hello') }, pins({ uncensored: true }), world()))).toEqual([
    'no uncensored model is available from the providers you have connected',
  ])
})

test('a provider with no key is not a rung, and the sentence says only that', () => {
  const none = world({ rungs: [] })
  expect(ids(route({ messages: asked('hello') }, pins(), none))).toEqual([
    'no provider is connected — add a key in settings, or install a local model and type /local',
  ])

  // Connected, and the catalog has not arrived. Not the same wall, and not the same fix:
  // telling somebody to add the key they already added is the bug this splits.
  const empty = world({ models: [] })
  expect(ids(route({ messages: asked('hello') }, pins(), empty))).toEqual([
    'no model list has arrived yet for the provider you connected — open the Models tab to fetch one, or check your connection',
  ])

  // Only beta is connected, so only beta's models are on the list.
  const half = world({ rungs: [remaining(store, beta)] })
  expect(ids(route({ messages: asked('hello') }, pins(), half))).toEqual(['paid/small', 'paid/frontier'])
})

test('a spent free tier costs the free models, not the key', () => {
  // Alpha has used its day. What is exhausted is what alpha gives away, so alpha's paid
  // models stay — and beta, which has headroom, is untouched. The bug this replaces read
  // a spent tier as a disconnected provider and answered "no provider is connected" to
  // somebody whose key was in the keychain.
  const ledger = new Store(':memory:')
  for (let i = 0; i < alpha.rpd!; i++) sent(ledger, alpha, noon + i * 61_000)
  const at = noon + alpha.rpd! * 61_000
  const drained = world({ rungs: [remaining(ledger, alpha, at), remaining(ledger, beta, at)] })

  expect(ids(route({ messages: asked('hello') }, pins(), drained))).toEqual(['paid/small', 'paid/frontier'])

  // And when honouring the ledger would leave nothing at all, it is not honoured: it is a
  // guess at somebody else's published number — OpenRouter's own doubles on a $10 top-up —
  // and asking for a 429 beats refusing while a working key sits there.
  const alone = world({ models: [freeText, freeTools], rungs: [remaining(ledger, alpha, at)] })
  expect(ids(route({ messages: asked('hello') }, pins(), alone))).toEqual(['free/text', 'free/tools'])
  ledger.close()
})


test('the user naming a model is the end of the conversation', () => {
  const ask = { messages: asked('hello'), minTier: 'T3' as const }
  expect(ids(route(ask, pins({ model: 'free/text' }), world()))).toEqual(['free/text'])
  expect(ids(route(ask, pins({ model: 'nope/gone' }), world()))).toEqual(['nope/gone is not available right now.'])
})

// ---- and the half that actually sends -----------------------------------------------------

let refuse = new Set<string>()
const server: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const { model: asked } = JSON.parse(raw) as { model: string }
    if (refuse.has(asked)) {
      response.writeHead(429, { 'content-type': 'text/plain' })
      response.end('slow down')
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'here' } }] })}\n\n` +
        `data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
    )
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
afterAll(() => {
  server.close()
  store.close()
})

const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`

test('a rung that says 429 is the next rungs turn, and the charge is announced first', async () => {
  const secrets = memorySecrets()
  const one = { ...alpha, baseUrl: at }
  const two = { ...beta, baseUrl: at }
  await secrets.set(CORE, keyOf(one), 'sk-a')
  await secrets.set(CORE, keyOf(two), 'sk-b')

  refuse = new Set(['free/text'])
  const notes: string[] = []
  const ledger = new Store(':memory:')
  const answer = await send(
    [
      { model: freeText, provider: one },
      { model: cheapPaid, provider: two },
    ],
    { messages: asked('hello') },
    ledger,
    secrets,
    { onNote: (line) => notes.push(line) },
  )

  expect(answer.model.id).toBe('paid/small')
  expect(answer.message.content).toBe('here')
  expect(answer.usage).toEqual({ in: 10, out: 2 })

  // Said before the request, not after the bill.
  expect(notes).toEqual(['The free models are used up, so this one goes to paid/small, which costs money.'])

  // The free one was counted even though it came back 429 — a refused request still spent
  // the tier that refused it, which is exactly what the pool has to know next time.
  expect(ledger.requests('alpha').minute).toBe(1)

  // The paid one was not, because this ledger is a ledger of the *free* tier. A model
  // billed to credit spends none of the daily allowance, and counting it there is how a key
  // with money behind it talked itself out of its own pool halfway through a day.
  expect(ledger.requests('beta').minute).toBe(0)
  ledger.close()
})

test('the hard stop takes the paid rungs off the table and says which wall it hit', async () => {
  const secrets = memorySecrets()
  const two = { ...beta, baseUrl: at }
  await secrets.set(CORE, keyOf(two), 'sk-b')
  refuse = new Set()

  const ledger = new Store(':memory:')
  await expect(
    send([{ model: cheapPaid, provider: two }], { messages: asked('hello') }, ledger, secrets, {
      paidAllowed: false,
    }),
  ).rejects.toMatchObject({ status: 402 })

  // Not sent, so not counted, and nothing spent.
  expect(ledger.requests('beta').minute).toBe(0)
  expect(ledger.spend(0)).toBe(0)
  ledger.close()
})

test('what an answer cost is recorded against whoever asked for it', async () => {
  const secrets = memorySecrets()
  const two = { ...beta, baseUrl: at }
  await secrets.set(CORE, keyOf(two), 'sk-b')
  refuse = new Set()

  const ledger = new Store(':memory:')
  const session = ledger.createSession('First')
  await send([{ model: cheapPaid, provider: two }], { messages: asked('hello') }, ledger, secrets, {
    session,
    plugin: 'somebody',
    // A plugin's work *inside a task* still spends: somebody is at the keyboard and the
    // preview was theirs to read. The run id is what says so — see the test below.
    run: 'a-task',
  })

  // 10 tokens in at $0.20 a million. Small, but attributed three ways.
  expect(ledger.spend(0)).toBeCloseTo(0.000_002)
  expect(ledger.spend(0, { session })).toBeCloseTo(0.000_002)
  expect(ledger.spendBy('plugin', 0)).toEqual([{ key: 'somebody', cost: expect.closeTo(0.000_002) }])
  ledger.close()
})

test('a plugin working on its own clock spends nothing but free', async () => {
  // G12 (D96). A call attributed to a plugin and belonging to no run is one nobody asked
  // for at the keyboard — a poll loop that found a message, a timer that woke up — and the
  // spend preview that makes an expensive run somebody's decision has nobody to show itself
  // to. So the ceiling is a tier rather than a number, and it is derived here rather than
  // set at each call site, because a flag at a call site is a flag somebody forgets.
  const secrets = memorySecrets()
  const one = { ...alpha, baseUrl: at }
  const two = { ...beta, baseUrl: at }
  await secrets.set(CORE, keyOf(one), 'sk-a')
  await secrets.set(CORE, keyOf(two), 'sk-b')
  refuse = new Set()

  const ledger = new Store(':memory:')
  await expect(
    send([{ model: cheapPaid, provider: two }], { messages: asked('anything') }, ledger, secrets, {
      plugin: 'telegram',
    }),
  ).rejects.toMatchObject({
    status: 402,
    // Which wall, in words that name the next action. *Raise your cap* is the wrong advice
    // here, and it is what the one message this used to have would have said.
    message: expect.stringContaining('works on its own and does not spend money'),
  })
  expect(ledger.spend(0)).toBe(0)

  // The free rung is not blocked, which is the half that makes this a ceiling rather than a
  // ban: a phone still gets answered, on the models that cost nothing.
  const free = await send([{ model: freeText, provider: one }], { messages: asked('anything') }, ledger, secrets, {
    plugin: 'telegram',
  })
  expect(free.model.id).toBe('free/text')
  ledger.close()
})

test('every rung refusing is the caller problem, not a silent empty answer', async () => {
  const secrets = memorySecrets()
  const one = { ...alpha, baseUrl: at }
  await secrets.set(CORE, keyOf(one), 'sk-a')
  refuse = new Set(['free/text'])

  const ledger = new Store(':memory:')
  await expect(
    send([{ model: freeText, provider: one }], { messages: asked('hello') }, ledger, secrets),
  ).rejects.toMatchObject({ status: 429 })
  ledger.close()
})
