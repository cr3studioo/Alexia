// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, test } from 'vitest'
import type { Model } from '../src/catalog.js'
import { remaining } from '../src/pool.js'
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

test('a provider with no key, or nothing left today, is not a rung', () => {
  const none = world({ rungs: [] })
  expect(ids(route({ messages: asked('hello') }, pins(), none))).toEqual([
    'no provider is connected and nothing has anything left — add a key in settings, or install a local model and type /local',
  ])

  // Only beta is connected, so only beta's models are on the list.
  const half = world({ rungs: [remaining(store, beta)] })
  expect(ids(route({ messages: asked('hello') }, pins(), half))).toEqual(['paid/small', 'paid/frontier'])
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

  // Both were counted: a request that came back 429 still counted against the tier that
  // refused it, which is exactly what the pool has to know next time.
  expect(ledger.requests('alpha').minute).toBe(1)
  expect(ledger.requests('beta').minute).toBe(1)
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
  })

  // 10 tokens in at $0.20 a million. Small, but attributed three ways.
  expect(ledger.spend(0)).toBeCloseTo(0.000_002)
  expect(ledger.spend(0, { session })).toBeCloseTo(0.000_002)
  expect(ledger.spendBy('plugin', 0)).toEqual([{ key: 'somebody', cost: expect.closeTo(0.000_002) }])
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
