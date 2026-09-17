// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, test } from 'vitest'
import type { Model } from '../src/catalog.js'
import { borrow, SEEDED } from '../src/catalog.js'
import { remaining, sent, usable } from '../src/pool.js'
import { anonymous, keyOf, ProviderError, PROVIDERS, type Provider } from '../src/provider.js'
import { OLLAMA } from '../src/ollama.js'
import {
  bubble,
  failed,
  MODES,
  route,
  send,
  shapeOf,
  stopped,
  STRIKE_HALF_LIFE,
  type Choice,
  type Pins,
  type Strike,
  type Switch,
  type World,
} from '../src/router.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import type { Message } from '../src/store.js'
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
// A *small paid* model worth buying: it can read four times what the free ones can. The
// window matters because a paid model that is merely equal to the free rung it stands in for
// is not a rung at all — see `stepUp` in the router — so a fixture whose paid model was a
// sidegrade would be testing a purchase the router is right to refuse.
const cheapPaid = model({
  id: 'paid/small',
  tier: 'T2',
  priceIn: 0.2,
  supportsTools: true,
  provider: 'beta',
  context: 128_000,
})
const frontier = model({ id: 'paid/frontier', tier: 'T3', priceIn: 5, supportsTools: true, provider: 'beta' })
const localSmall = model({ id: 'qwen3:8b', tier: 'T0', provider: 'ollama', supportsTools: true })

const noon = Date.UTC(2026, 7, 27, 12, 0, 0)
const store = new Store(':memory:')
// Nothing installed on this machine, and that is now something a fixture has to say. Local
// is a rung of the cloud cascade since it became one, so a local model left in the default
// world would sit in the middle of every ordering assertion in this file whether or not the
// test was about it. The ones that are about it hand `local` in themselves.
const world = (over: Partial<World> = {}): World => ({
  models: [freeText, freeTools, cheapPaid, frontier],
  local: [],
  rungs: [remaining(store, alpha), remaining(store, beta)],
  // A dollar allowed for today, because most of what is tested here is the ordering and the
  // filters, and with no allowance there is no paid half of the list to order. The tests that
  // are about the allowance itself say so by taking it away.
  today: { spent: 0, allowance: 1 },
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
  // Hands before mouths, even for a question that needs neither (§8.1, §8.2): `free/tools`
  // can call a tool and `free/text` cannot, and they are otherwise the same row.
  expect(ids(route({ messages: asked('capital of Norway') }, pins(), world()))).toEqual([
    'free/tools',
    'free/text',
    'paid/small',
    'paid/frontier',
  ])

  // Tools narrow it to models that have them, still cheapest first.
  const withTools = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }
  expect(ids(route(withTools, pins(), world()))).toEqual(['free/tools', 'paid/small', 'paid/frontier'])

  // And `/best` walks from the other end.
  expect(ids(route({ messages: asked('refactor this') }, pins({ prefer: 'best' }), world()))).toEqual([
    'paid/frontier',
    'paid/small',
    'free/text',
    'free/tools',
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
  // A wider window than the free one, so it is a step up rather than the same answer for
  // money — otherwise the router is right to drop it and this would be testing the wrong rule.
  const paid = model({
    id: 'paid/known',
    tier: 'T2',
    priceIn: 0.2,
    supportsTools: true,
    weekly: 9_000_000,
    context: 128_000,
  })
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
  const machine = world({ local: [localSmall] })
  expect(ids(route({ messages: asked('hello') }, pins({ placement: MODES.local }), machine))).toEqual([
    'qwen3:8b',
  ])

  // The sentence the spec asks for, word for word in intent: what is missing, and what to type.
  const uncensored = pins({ placement: MODES.local, uncensored: true })
  expect(ids(route({ messages: asked('hello') }, uncensored, machine))).toEqual([
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
    'no provider is connected — add a key in settings, or install a local model',
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
  expect(ids(route({ messages: asked('hello') }, pins(), alone))).toEqual(['free/tools', 'free/text'])
  ledger.close()
})


test('the user naming a model is the end of the conversation', () => {
  const ask = { messages: asked('hello'), minTier: 'T3' as const }
  expect(ids(route(ask, pins({ model: 'free/text' }), world()))).toEqual(['free/text'])
  expect(ids(route(ask, pins({ model: 'nope/gone' }), world()))).toEqual(['nope/gone is not available right now.'])
})

// ---- and the half that actually sends -----------------------------------------------------

let refuse = new Set<string>()
/** Models that answer `200` and stream nothing — the free tier is full of them. */
let mute = new Set<string>()
/** Models that refuse this caller specifically, the way a gated free row does. */
let gated = new Set<string>()
/** Models no worker is serving right now, the way a volunteer roster says so. */
let unserved = new Set<string>()
/**
 * Everything else a provider does to an answer (D155), by model: a status with its own words,
 * a stream that dies after five chunks, a provider that never answers, a reply cut at its ceiling.
 */
let behave = new Map<string, { status: number; body?: string } | 'dies' | 'hangs' | 'cut'>()
/** Every model asked, in order — so a test can say what was *not* asked. */
const called: string[] = []
const server: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const { model: asked } = JSON.parse(raw) as { model: string }
    called.push(asked)
    const how = behave.get(asked)
    if (how === 'hangs') return
    if (how === 'dies') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const word of ['one ', 'two ', 'three ', 'four ', 'five ']) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`)
      }
      setTimeout(() => response.destroy(), 20)
      return
    }
    if (how === 'cut') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'half' }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`,
      )
      return
    }
    if (how !== undefined) {
      response.writeHead(how.status, { 'content-type': 'text/plain' })
      response.end(how.body ?? 'no')
      return
    }
    if (refuse.has(asked)) {
      response.writeHead(429, { 'content-type': 'text/plain' })
      response.end('slow down')
      return
    }
    if (gated.has(asked)) {
      response.writeHead(403, { 'content-type': 'text/plain' })
      response.end(`${asked} is only available on agentic harnesses`)
      return
    }
    if (unserved.has(asked)) {
      response.writeHead(406, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ detail: 'Model None not known!' }))
      return
    }
    if (mute.has(asked)) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '' } }] })}

` +
          `data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 0 } })}

data: [DONE]

`,
      )
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
    // A bound on the reply, because a paid rung is in this plan and `send` will not bill
    // without one.
    { messages: asked('hello'), maxTokens: 200 },
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
    send([{ model: cheapPaid, provider: two }], { messages: asked('hello'), maxTokens: 200 }, ledger, secrets, {
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
  await send([{ model: cheapPaid, provider: two }], { messages: asked('hello'), maxTokens: 200 }, ledger, secrets, {
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
    send([{ model: cheapPaid, provider: two }], { messages: asked('anything'), maxTokens: 200 }, ledger, secrets, {
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

/**
 * The slider (D112), which is a **filter** and not a preference.
 *
 * That distinction is the whole of it: *free only* that reaches for a paid model when every
 * free one is rate-limited is the setting not existing, which is what *recommended* was.
 */
test('the spend axis is a wall, and the middle of it is what Automatic always did', () => {
  const work = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }

  // The middle, and the default: free first, paid behind it. Absent means this.
  expect(ids(route(work, pins(), world()))).toEqual(['free/tools', 'paid/small', 'paid/frontier'])
  expect(ids(route(work, pins({ spend: 'mixed' }), world()))).toEqual(['free/tools', 'paid/small', 'paid/frontier'])

  // Left. The paid rows are not last, they are not there — so a free tier that runs out
  // produces a sentence rather than a charge.
  expect(ids(route(work, pins({ spend: 'free' }), world()))).toEqual(['free/tools'])

  // Right. The free tiers are left alone, which is what somebody paying wants when the free
  // ones are the reason answers are slow.
  expect(ids(route(work, pins({ spend: 'paid' }), world()))).toEqual(['paid/small', 'paid/frontier'])
})

test('a slider that empties the pool says it was the slider', () => {
  const work = { messages: asked('hello'), tools: [{ name: 'fs.list' }] }
  const onlyFree = world({ models: [freeText, freeTools] })

  const refused = route(work, pins({ spend: 'paid' }), onlyFree)
  expect(refused.ok).toBe(false)
  // Names the control, not the keychain. The one thing this must never say is *add a key*
  // to somebody whose key is the reason there is anything here at all (D107's lesson).
  expect(refused.ok === false && refused.why).toContain('paid only')
  expect(refused.ok === false && refused.why).not.toContain('add a key')
})

/**
 * **The spend axis is about the price line, and only the cloud pool has one.**
 *
 * A model on this machine is free in a different sense — nothing is billed and nothing is
 * rate-limited — so *paid only* applied to a local pool would empty it and refuse with a
 * sentence that reads as a bug: you asked for local, and it told you nothing local costs
 * enough.
 */
test('paid only does not empty this machine', () => {
  const local = pins({ placement: MODES.local, spend: 'paid' })
  expect(ids(route({ messages: asked('hello') }, local, world({ local: [localSmall] })))).toEqual(['qwen3:8b'])
})

/**
 * **Local is a rung of the cloud cascade, at the bottom of it** (§8.3, §16 Q1).
 *
 * It was not one before: `MODES.combined` places `text` in the cloud, so a model somebody had
 * already downloaded was not a candidate for a single sentence of the cascade — you had to
 * remember to type `/local` to reach it, which is a mode, not a fallback.
 *
 * Low rather than high, and that is the owner's correction rather than a preference. Privacy
 * is enforced by mode selection: the person who wants it types `/local` and the cloud cascade
 * is gone entirely, which is the test below this one. So the cascade only ever runs for
 * somebody who did not ask for privacy, and for them the thing on their machine is a slow
 * helper that lives in their house rather than the private one.
 */
test('the machine is a low rung of the cascade, not the first one', () => {
  // Everything tool-capable, so the hands-before-mouths key is not what is being read here:
  // this is about where the machine sits among helpers that can all do the same work.
  const installed = world({ models: [freeTools, cheapPaid, frontier], local: [localSmall] })

  // Behind every keyed free tier, ahead of everything that charges. `T0` is the cheapest tier
  // there is and the comparator would have read that as *first* — which is the exact opposite
  // of low, and the reason this is a rule of its own rather than a fall-through.
  expect(ids(route({ messages: asked('capital of Norway') }, pins(), installed))).toEqual([
    'free/tools',
    'qwen3:8b',
    'paid/small',
    'paid/frontier',
  ])

  // And it is a rung under the same filters as any other, not a special case bolted under
  // them: work needing hands reaches it the same way a plain question does.
  const work = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }
  expect(ids(route(work, pins(), installed))).toEqual(['free/tools', 'qwen3:8b', 'paid/small', 'paid/frontier'])
})

test('with the keyed tiers spent, the cascade reaches this machine instead of a bill', () => {
  // §9.3's *tired* row, now that there is somewhere for it to land: alpha has used its day,
  // so nothing free and keyed is left, and the next rung down is the one in the house. The
  // paid rungs are still behind it — this is an order, not a wall.
  const ledger = new Store(':memory:')
  for (let i = 0; i < alpha.rpd!; i++) sent(ledger, alpha, noon + i * 61_000)
  const at = noon + alpha.rpd! * 61_000
  const drained = world({
    local: [localSmall],
    rungs: [remaining(ledger, alpha, at), remaining(ledger, beta, at)],
  })

  expect(ids(route({ messages: asked('hello'), tools: [{ name: 'fs.list' }] }, pins(), drained))).toEqual([
    'qwen3:8b',
    'paid/small',
    'paid/frontier',
  ])

  // With nothing allowed for today the paid half is closed, and the machine is still there.
  // That is the whole point of putting it in the cascade: the answer to a spent free tier
  // stops being a sentence about money.
  const skintToo = world({
    local: [localSmall],
    today: { spent: 0, allowance: 0 },
    rungs: [remaining(ledger, alpha, at), remaining(ledger, beta, at)],
  })
  expect(ids(route({ messages: asked('hello'), tools: [{ name: 'fs.list' }] }, pins(), skintToo))).toEqual([
    'qwen3:8b',
  ])
  ledger.close()
})

test('a list can put this machine first, because that is somebody typing it', () => {
  // The rule above is about a default reaching for local first, not about arguing with a
  // person who dragged their own model to the top. The group still wins — free before paid —
  // and inside it the list the user wrote is the order, ahead of the local rule.
  const work = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }
  const installed = world({ local: [localSmall] })
  expect(ids(route(work, pins({ order: ['free/tools', 'qwen3:8b'] }), installed))).toEqual(['free/tools', 'qwen3:8b'])
  expect(ids(route(work, pins({ order: ['qwen3:8b', 'free/tools'] }), installed))).toEqual(['qwen3:8b', 'free/tools'])
  // And the list is the whole plan (D155): with only the machine on it, nothing else is behind it.
  expect(ids(route(work, pins({ order: ['qwen3:8b'] }), installed))).toEqual(['qwen3:8b'])
})

/**
 * **The ladder, walked top to bottom** (§8.2).
 *
 * Nine rungs on paper, and two sort keys plus one filter here — §8.1 is explicit that the
 * hands/mouths split needs no new structure, and neither does the rest of it: *is it on this
 * machine* and *will it answer a stranger* are already written on the rows.
 *
 * The half of the ladder that matters most is the bottom of the hands half. Rung 5 is
 * keyless **and** tool-capable, so the loop still has hands when there is nothing in the
 * keychain at all — and only below that, at rung 6 and down, is Alexia reduced to talking.
 */
test('the ladder runs hands first, then mouths, and each half keyed then here then keyless', () => {
  const keyless: Provider = { id: 'floor', name: 'Floor', baseUrl: 'http://127.0.0.1:3', auth: 'optional' }
  const hands = (id: string, over: Partial<Model> = {}): Model =>
    model({ id, tier: 'T1', supportsTools: true, ...over })
  const mouth = (id: string, over: Partial<Model> = {}): Model => model({ id, tier: 'T1', ...over })

  // One model per rung, listed worst-first so the catalog's own order cannot be what decides
  // it — the same trap the `weekly` tie-break was added for.
  const nine = world({
    models: [
      mouth('9/keyless-chat', { provider: 'floor' }),
      mouth('6/keyed-chat'),
      hands('5/keyless-hands', { provider: 'floor' }),
      hands('1/keyed-hands'),
    ],
    local: [
      model({ id: '8/here-chat', tier: 'T0', provider: 'ollama' }),
      model({ id: '4/here-hands', tier: 'T0', provider: 'ollama', supportsTools: true }),
    ],
    rungs: [remaining(store, alpha), remaining(store, keyless)],
  })

  expect(ids(route({ messages: asked('hello') }, pins(), nine))).toEqual([
    '1/keyed-hands',
    '4/here-hands',
    '5/keyless-hands',
    '6/keyed-chat',
    '8/here-chat',
    '9/keyless-chat',
  ])

  // And the filter, which is the other half of §8.1: work that needs hands does not order the
  // talkers, it removes them. The hands half comes back in the same order it just had.
  const work = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }
  expect(ids(route(work, pins(), nine))).toEqual(['1/keyed-hands', '4/here-hands', '5/keyless-hands'])
})

/**
 * **Rung 2 cannot be in a shipped cascade** (§14.1).
 *
 * D53 and M4-7: the Claude Code plugin ships off, is never auto-enabled, and the user runs
 * `claude setup-token` themselves. So the subscription is not a provider row and never was —
 * it reaches Alexia as a plugin offering a tool, which is a thing somebody switches on by
 * hand and not a rung a default ladder can walk onto by itself.
 */
test('rung 2 is not something the shipped cascade can reach on its own', () => {
  const subscription = /claude|anthropic/i
  expect(PROVIDERS.filter((p) => subscription.test(p.id) || subscription.test(p.name))).toEqual([])

  // And the gate underneath that, which is the one that would still hold on the day somebody
  // does write such a row: **nothing enters the pool that has not been connected.** A model
  // whose provider is not among the rungs is not last in the ladder, it is not in it.
  const anthropic: Provider = {
    id: 'a-subscription',
    name: 'A subscription',
    baseUrl: 'http://127.0.0.1:4',
    auth: 'required',
  }
  const sub = model({ id: 'sub/monthly', tier: 'T1', supportsTools: true, provider: 'a-subscription' })
  const locked = world({ models: [freeTools, sub] })
  expect(ids(route({ messages: asked('hello') }, pins(), locked))).toEqual(['free/tools'])

  // Unlocked is somebody having gone and unlocked it, and then it is a rung like any other.
  const unlocked = world({ models: [freeTools, sub], rungs: [remaining(store, alpha), remaining(store, anthropic)] })
  expect(ids(route({ messages: asked('hello') }, pins(), unlocked))).toContain('sub/monthly')
})

/**
 * **Rung 5, with nothing in the keychain** — §8.2's important refinement, checked against the
 * real table rather than a fixture. Keyless *and* tool-capable means the agent loop survives
 * to the no-key floor: slowly, at two requests a minute, but with hands.
 */
test('the loop still has hands on the keyless floor', async () => {
  const empty = new Store(':memory:')
  const floor: World = {
    models: SEEDED,
    // No Ollama, no keys, no allowance: a machine somebody has just installed this on.
    local: [],
    rungs: await usable(empty, memorySecrets()),
    today: { spent: 0, allowance: 0 },
  }
  expect(floor.rungs.every((rung) => anonymous(rung.provider))).toBe(true)

  const work = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }
  const plan = route(work, pins(), floor)
  expect(plan.ok, plan.ok ? '' : plan.why).toBe(true)
  if (plan.ok) {
    // Every rung of it can call a tool — a plan that fell to a talker would be the loop
    // stranded on its second step — and the one at the top is the row §6.2 probed by hand.
    expect(plan.choices.every((c) => c.model.supportsTools)).toBe(true)
    expect(plan.choices[0]?.provider.id).toBe('ovhcloud')
  }
  empty.close()
})

/**
 * **The bubbles** (§8.4), which are what the ladder looks like from the outside.
 *
 * One rule decides what they may say: the bubble says what the assistant can **do**, not what
 * it costs. *Just chat now* is worth reading and *currently paid* is not — nobody cares that
 * an answer was billed, they care whether the thing can still pick a file up.
 */
test('every rung the cascade can reach says what it can do, in §8.2’s words', () => {
  const keyed: Provider = { id: 'keyed', name: 'Keyed', baseUrl: 'http://127.0.0.1:5', auth: 'required' }
  const floor: Provider = { id: 'floor', name: 'Floor', baseUrl: 'http://127.0.0.1:6', auth: 'optional' }
  const said = (m: Partial<Model> & Pick<Model, 'id' | 'tier'>, provider: Provider) =>
    bubble({ model: model(m), provider })

  expect(said({ id: 'a', tier: 'T1', supportsTools: true }, keyed)).toEqual({
    rung: 1,
    says: 'ready for anything',
    state: 'green',
  })
  // Rung 4 takes §8.4's capability tag rather than §8.2's *using your computer*: that section
  // asks local bubbles to say what they are good for, and this is one of the three it offers.
  expect(said({ id: 'b', tier: 'T0', supportsTools: true }, OLLAMA)).toEqual({
    rung: 4,
    says: 'good for agentic, slow',
    state: 'amber',
  })
  // The refinement that keeps the loop alive with an empty keychain: keyless *and* hands.
  expect(said({ id: 'c', tier: 'T1', supportsTools: true }, floor)).toEqual({
    rung: 5,
    says: 'free floor, still capable',
    state: 'amber',
  })
  expect(said({ id: 'd', tier: 'T1' }, keyed)).toEqual({ rung: 6, says: 'just chat now', state: 'red' })
  expect(said({ id: 'e', tier: 'T0' }, OLLAMA)).toEqual({ rung: 8, says: 'just chat', state: 'red' })
  expect(said({ id: 'f', tier: 'T1' }, floor)).toEqual({
    rung: 9,
    says: 'barely alive, but alive',
    state: 'red',
  })

  // A paid model is not a rung of its own and does not get a bubble of its own: money is a
  // permission rather than a place in the order (§9.2), and what the user needs to know from
  // this badge is whether the thing still has hands.
  expect(said({ id: 'g', tier: 'T3', supportsTools: true }, keyed).says).toBe('ready for anything')
})

test('no bubble mentions what anything costs', () => {
  const money = /paid|free tier|\$|cost|price|credit|cheap|billed|spend/i
  const rows: Choice[] = [
    { model: model({ id: 'a', tier: 'T1', supportsTools: true }), provider: alpha },
    { model: model({ id: 'b', tier: 'T3', supportsTools: true, priceIn: 5 }), provider: alpha },
    { model: model({ id: 'c', tier: 'T0', supportsTools: true, provider: 'ollama' }), provider: OLLAMA },
    { model: model({ id: 'd', tier: 'T0', provider: 'ollama' }), provider: OLLAMA },
    { model: model({ id: 'e', tier: 'T1' }), provider: alpha },
  ]
  // *Free floor, still capable* is the one that comes close, and it is about a capability:
  // the floor is where you stand, and *still capable* is the half that matters.
  const sayings = rows.map((row) => bubble(row).says).filter((says) => says !== 'free floor, still capable')
  expect(sayings.filter((says) => money.test(says))).toEqual([])
})

/**
 * **`/local` still shuts the cloud cascade off entirely**, which is the half of §8.3 that
 * makes the half above it safe. Privacy is a mode, not a position in an order: the moment it
 * is asked for, every hosted rung is gone rather than merely last.
 */
test('local placement is still every hosted rung gone, not merely last', () => {
  const installed = world({ local: [localSmall] })
  const private_ = pins({ placement: MODES.local })

  expect(ids(route({ messages: asked('hello') }, private_, installed))).toEqual(['qwen3:8b'])

  // Including when this machine cannot do the work and the cloud plainly could. A pin with
  // nothing behind it is a sentence, never a quiet reach for somebody else's server.
  const chatOnly = world({ local: [model({ id: 'qwen3:8b', tier: 'T0', provider: 'ollama' })] })
  expect(
    ids(route({ messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }, private_, chatOnly)),
  ).toEqual(['no local model here can use tools — install one that can, or type /cloud'])

  // And the image class is untouched by any of this: `combined` places it local already, so
  // there was never a cloud cascade for it to be the bottom of.
  expect(ids(route({ messages: asked('draw a cat'), class: 'image' }, pins(), installed))).toEqual(['qwen3:8b'])
})

/**
 * The running order (D112) — a shortlist, and the group still wins.
 *
 * A paid model dragged to the top of its own column is still paid. If the list could move a
 * row across the line, one drag would quietly turn the free tier off, which is exactly the
 * surprise the slider above it exists to stop.
 */
test('the user’s own order is read within a group, never across one', () => {
  const work = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }

  // Frontier named first, and it still sorts behind the free model — because it is paid.
  expect(ids(route(work, pins({ order: ['paid/frontier', 'free/tools'] }), world()))).toEqual([
    'free/tools',
    'paid/frontier',
  ])

  // Within the paid group it is the whole point: the dearer one first because it was asked
  // for, ahead of the rule that would otherwise have chosen for you.
  expect(ids(route(work, pins({ spend: 'paid', order: ['paid/frontier', 'paid/small'] }), world()))).toEqual([
    'paid/frontier',
    'paid/small',
  ])

  // And an empty list is Automatic, which is what makes the list optional rather than a form
  // to fill in.
  const empty = route(work, pins({ order: [] }), world())
  expect(ids(empty)).toEqual(ids(route(work, pins(), world())))
  expect(empty.mode).toBe('automatic')
})

test('a model that has left the catalog is skipped in the list, and a list of only those stops', () => {
  const work = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }
  // One entry gone: the rest of the list is still the list.
  expect(ids(route(work, pins({ order: ['gone/yesterday', 'paid/small'] }), world()))).toEqual(['paid/small'])

  // Every entry gone. D112 fell through to everything else here; a list somebody made is the
  // whole plan now, so it says the list is empty rather than quietly answering from outside it.
  const stranded = route(work, pins({ order: ['gone/yesterday', 'also/gone'] }), world())
  expect(stranded).toMatchObject({ ok: false, mode: 'sequence' })
  expect(ids(stranded)[0]).toContain('none of the models in your order can be reached')
})

/**
 * **Three modes, three promises** (D155). Which one a plan is in decides how far a failure may
 * walk, so the mode travels on the verdict and the rule lives in the plan rather than in `send`.
 */
test('the plan says whose choice it is: nobody, a list, or one model', () => {
  const work = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }
  expect(route(work, pins(), world()).mode).toBe('automatic')
  expect(route(work, pins({ order: ['free/tools'] }), world()).mode).toBe('sequence')
  expect(route(work, pins({ model: 'free/text', order: ['free/tools'] }), world()).mode).toBe('pinned')
})

test('a list never reaches past its last entry, even when a model outside it would answer', () => {
  // The work needs hands and the only model on the list has none. Automatic would hand it to
  // `free/tools`; a list somebody wrote does not, and it says why in words about the list.
  const work = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }
  const verdict = route(work, pins({ order: ['free/text'] }), world())
  expect(verdict).toMatchObject({ ok: false, mode: 'sequence' })
  expect(ids(verdict)).toEqual(['none of the models in your order can use tools, and this needs them'])
})

test('the ledger does not refuse somebody’s own choice before it has been tried', () => {
  // alpha has used its day by this machine's count — a count D107 calls a deliberately low
  // copy of somebody else's number. Automatic leaves alpha's free rows out while anything
  // else is left; a pin used to be refused outright, *is not available right now*, on a guess.
  const ledger = new Store(':memory:')
  for (let i = 0; i < alpha.rpd!; i++) sent(ledger, alpha, noon + i * 61_000)
  const at = noon + alpha.rpd! * 61_000
  const freeBeta = model({ id: 'free/beta', tier: 'T1', provider: 'beta', supportsTools: true })
  const drained = world({
    models: [freeText, freeTools, freeBeta, cheapPaid],
    rungs: [remaining(ledger, alpha, at), remaining(ledger, beta, at)],
  })
  const work = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }

  expect(ids(route(work, pins(), drained))).toEqual(['free/beta', 'paid/small'])
  expect(ids(route(work, pins({ model: 'free/tools' }), drained))).toEqual(['free/tools'])
  // A list keeps its spent entry, in the place it was written: the one list somebody wanted is
  // worth a 429.
  expect(ids(route(work, pins({ order: ['free/tools', 'free/beta'] }), drained))).toEqual(['free/tools', 'free/beta'])
  ledger.close()
})

test('one model on two providers, in a list: your key before the keyless floor, whatever the catalog read first', () => {
  // Measured on this machine's catalog: each Nemotron in the owner's list is served by Kilo's
  // keyless floor *and* by OpenRouter, and Kilo's rows come first in the file. The list names
  // the model; which provider serves it first is the ladder's call, not the file's.
  const floor: Provider = { id: 'floor', name: 'Floor', baseUrl: 'http://127.0.0.1:3', auth: 'optional' }
  const onFloor = model({ id: 'same/model', tier: 'T1', supportsTools: true, provider: 'floor' })
  const onKey = model({ id: 'same/model', tier: 'T1', supportsTools: true, provider: 'alpha' })
  const next = model({ id: 'next/model', tier: 'T1', supportsTools: true, provider: 'floor' })
  const both = world({
    models: [onFloor, next, onKey],
    rungs: [remaining(store, floor), remaining(store, alpha)],
  })
  const plan = route({ messages: asked('hello') }, pins({ order: ['same/model', 'next/model'] }), both)
  expect(plan.ok && plan.choices.map((c) => `${c.model.id}@${c.provider.id}`)).toEqual([
    'same/model@alpha',
    'same/model@floor',
    'next/model@floor',
  ])
})

// The context filter. `Model.context` existed since the catalog did and was read by nothing,
// which is the gap that would have broken the keyless floor first — the models down there are
// 32k, and a conversation that outgrows one is a hard failure rather than a shorter answer.

const narrow = model({ id: 'free/narrow', tier: 'T1', context: 8_192 })
const wide = model({ id: 'free/wide', tier: 'T1', context: 200_000 })
const windows = (over: Partial<World> = {}): World =>
  world({ models: [narrow, wide], local: [], ...over })

/** A user turn of a given size. Characters, because that is the unit a trace is measured in. */
const long = (chars: number): Message[] => [{ role: 'user', content: 'x'.repeat(chars) }]

test('a window too small for the trace drops out of the pool, like a spent free tier', () => {
  // 40k characters is comfortably past 8,192 tokens and nowhere near 200,000.
  expect(ids(route({ messages: long(40_000) }, pins(), windows()))).toEqual(['free/wide'])

  // And both are candidates again for a short one. The filter is about this request, not a
  // verdict on the model.
  expect(ids(route({ messages: asked('capital of Norway') }, pins(), windows()))).toEqual([
    'free/narrow',
    'free/wide',
  ])
})

test('a request carrying a picture only reaches models that can be given one', () => {
  // The catalog has collected `modality` since it existed and nothing ever filtered on it —
  // it was printed under a model row on the Models screen and that was the whole of its use.
  // Nothing can put a picture in a message yet, so this is a rule ahead of its user: the day
  // one can, the alternative to this filter is a 400 from somebody else's server.
  const seeing = model({ id: 'free/sees', tier: 'T1', supportsTools: true, modality: ['text', 'image'] })
  const both = world({ models: [freeText, freeTools, seeing] })

  expect(ids(route({ messages: asked('what is in this'), modality: ['image'] }, pins(), both))).toEqual(['free/sees'])
  // And `text` says nothing about anybody, so asking for it changes nothing.
  expect(ids(route({ messages: asked('hello'), modality: ['text'] }, pins(), both))).toEqual([
    'free/tools',
    'free/sees',
    'free/text',
  ])
})

test('nothing that can see is its own refusal, and it names the fix', () => {
  // Said before every other wall, because every other sentence sends somebody to do
  // something — add a key, move the slider — that does not make a model able to see.
  const blind = world({ models: [freeText, freeTools], local: [localSmall], today: { spent: 0, allowance: 0 } })
  const asking = { messages: asked('what is in this'), modality: ['image'] }
  expect(ids(route(asking, pins(), blind))[0]).toMatch(/can be given a picture/)
  expect(ids(route(asking, pins({ placement: MODES.local }), blind))[0]).toMatch(/installed on this machine/)
  // A model on this machine that *can* be given one is the same answer as a hosted one:
  // this is a property of the row, not of where the row lives.
  const seeingHere = model({ id: 'qwen2.5vl:7b', tier: 'T0', provider: 'ollama', modality: ['text', 'image'] })
  expect(ids(route(asking, pins({ placement: MODES.local }), world({ local: [localSmall, seeingHere] })))).toEqual([
    'qwen2.5vl:7b',
  ])
})

test('the filter measures the floor, not the whole trace', () => {
  // A long-running task: one enormous early cycle that trimming will summarise away, and a
  // small newest one. What the window has to hold is the head plus that newest cycle — the
  // part no amount of trimming can collapse — and judging the whole trace instead would
  // throw away a rung that can perfectly well answer.
  const trace: Message[] = [
    { role: 'user', content: 'sort my downloads' },
    { role: 'assistant', content: '', calls: [{ id: 'c0', name: 'fs.list', arguments: '{}' }] },
    { role: 'tool', content: 'x'.repeat(60_000), callId: 'c0' },
    { role: 'assistant', content: '', calls: [{ id: 'c1', name: 'fs.read', arguments: '{}' }] },
    { role: 'tool', content: 'two files, both short', callId: 'c1' },
  ]
  expect(ids(route({ messages: trace }, pins(), windows()))).toContain('free/narrow')

  // The same trace with the bulk in the *newest* cycle is the other answer: that part cannot
  // be collapsed, so the small window really is gone.
  const unavoidable: Message[] = [
    ...trace.slice(0, 3),
    { role: 'assistant', content: '', calls: [{ id: 'c1', name: 'fs.read', arguments: '{}' }] },
    { role: 'tool', content: 'y'.repeat(60_000), callId: 'c1' },
  ]
  expect(ids(route({ messages: unavoidable }, pins(), windows()))).toEqual(['free/wide'])
})

test('a small window plans nothing and cranks everything (§11.6)', () => {
  // A long task: a hundred and fifty steps behind it, each one small, and the newest one
  // small too. Nothing here is too big to *hold* — what is big is the history of it, which
  // is the part only a planning step needs.
  const trace: Message[] = [
    { role: 'user', content: 'sort my downloads' },
    ...Array.from({ length: 150 }, (_, i) => [
      {
        role: 'assistant' as const,
        content: '',
        calls: [{ id: `c${String(i)}`, name: 'fs.read', arguments: `{"name":"file-${String(i)}.txt"}` }],
      },
      { role: 'tool' as const, callId: `c${String(i)}`, content: `file ${String(i)}: ${'contents '.repeat(16)}` },
    ]).flat(),
  ]

  // Planning is measured against the floor *plus* the running summary: what was tried, what
  // worked, what is left. The 8k window cannot hold that, so it does not get to decide what
  // happens next.
  // Both of them have hands, because a step of a task always needs them: what is being
  // tested is the window, and a model filtered out for having no tools would prove nothing.
  const hands = windows({
    models: [
      model({ id: 'free/narrow', tier: 'T1', context: 8_192, supportsTools: true }),
      model({ id: 'free/wide', tier: 'T1', context: 200_000, supportsTools: true }),
    ],
  })
  expect(ids(route({ messages: trace, shape: 'hard' }, pins(), hands))).toEqual(['free/wide'])

  // The same trace, the same model, one step of turning the crank — read this file — which
  // needs the step it is on and almost nothing else. This is the free tier not becoming
  // useless as a task grows: it becomes the cranker.
  expect(ids(route({ messages: trace, shape: 'tools' }, pins(), hands))).toEqual(['free/narrow', 'free/wide'])
})

test('a model that does not publish a window is not judged on one', () => {
  // Silence is not smallness — the same reading `params` gets one filter down.
  const quiet = model({ id: 'free/quiet', tier: 'T1', context: 0 })
  expect(ids(route({ messages: long(40_000) }, pins(), world({ models: [quiet], local: [] })))).toEqual([
    'free/quiet',
  ])
})

test('when nothing can read the conversation, it says so rather than letting upstream 400', () => {
  expect(ids(route({ messages: long(40_000) }, pins(), world({ models: [narrow], local: [] })))).toEqual([
    'this conversation is longer than any model available to you can read — start a new chat, or connect a provider with a bigger context window',
  ])

  // And the local wall names the local fix, ahead of the planning sentence — which fires on
  // request shape alone and would otherwise send somebody to install a bigger model for
  // entirely the wrong reason.
  const here = model({ id: 'qwen3:8b', tier: 'T0', provider: 'ollama', supportsTools: true, context: 8_192, params: 8 })
  expect(
    ids(route({ messages: long(40_000) }, pins({ placement: MODES.local }), world({ models: [], local: [here] }))),
  ).toEqual([
    'this conversation is longer than any model installed here can read — install one with a bigger context window, or type /cloud',
  ])
})

// The allowance. `mixed` was the default and `mixed` filtered nothing, so the moment free was
// filtered out a paid model was billed with no cap and no confirmation — and the free-tier
// exhaustion path led straight into it.

/** The same world with nothing allowed for today, which is what a new install looks like. */
const skint = (over: Partial<World> = {}): World => world({ today: { spent: 0, allowance: 0 }, ...over })

test('a spent free tier no longer leads straight into billing', () => {
  // §9.1's path, exactly: alpha has used its day, so the free models are gone and the paid
  // ones on the same key are deliberately still alive. That used to be a bill.
  const ledger = new Store(':memory:')
  for (let i = 0; i < alpha.rpd!; i++) sent(ledger, alpha, noon + i * 61_000)
  const at = noon + alpha.rpd! * 61_000
  const drained = skint({ rungs: [remaining(ledger, alpha, at), remaining(ledger, beta, at)] })

  expect(ids(route({ messages: asked('hello') }, pins(), drained))).toEqual([
    'the free models are used up, and Alexia does not spend money on its own until you give it a daily allowance — set one in settings, or wait for the free tiers to reset',
  ])
  ledger.close()
})

test('with nothing allowed for today, Automatic is free only', () => {
  // Not a tier, not a rung, not a reordering — the same pool and the same order, with the
  // price line closed.
  expect(ids(route({ messages: asked('hello') }, pins(), skint()))).toEqual(
    ids(route({ messages: asked('hello') }, pins({ spend: 'free' }), world())),
  )

  // And the wall that used to be crossed silently is now a sentence: tools are what filters
  // every free model out in this fixture.
  const work = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }
  expect(ids(route(work, pins(), skint({ models: [freeText, cheapPaid, frontier] })))).toEqual([
    'the free models are used up, and Alexia does not spend money on its own until you give it a daily allowance — set one in settings, or wait for the free tiers to reset',
  ])
})

test('an allowance with room in it unlocks paid, and one that is spent closes it again', () => {
  const work = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }
  const only = { models: [freeText, cheapPaid, frontier] }

  expect(ids(route(work, pins(), world({ ...only, today: { spent: 0, allowance: 1 } })))).toEqual([
    'paid/small',
    'paid/frontier',
  ])

  // Spent to the line is spent. Daily rather than monthly because an agent loop can burn a
  // month in an hour, and because the free tiers this bridges reset on the same clock.
  expect(ids(route(work, pins(), world({ ...only, today: { spent: 1, allowance: 1 } })))).toEqual([
    'the free models are used up, and Alexia does not spend money on its own until you give it a daily allowance — set one in settings, or wait for the free tiers to reset',
  ])
})

test('the slider pushed to paid is somebody saying the words, and the allowance does not argue', () => {
  // This exists to stop a router spending on its own, not to overrule a person who typed it.
  expect(ids(route({ messages: asked('hello') }, pins({ spend: 'paid' }), skint()))).toEqual([
    'paid/small',
    'paid/frontier',
  ])
})

test('a world that never gathered the allowance is read as having none', () => {
  // Money is the one axis where forgetting has to fail closed: every other rung failure here
  // costs a slower answer, and this one would cost money.
  const ungathered: World = {
    models: [freeText, cheapPaid],
    local: [],
    rungs: [remaining(store, alpha), remaining(store, beta)],
  }
  const work = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }
  expect(ids(route(work, pins(), ungathered))[0]).toMatch(/does not spend money on its own/)
})

test('nothing is billed without a ceiling on the reply, and free is untouched', async () => {
  const secrets = memorySecrets()
  const one: Provider = { ...alpha, baseUrl: at }
  const two: Provider = { ...beta, baseUrl: at }
  await secrets.set(CORE, keyOf(one), 'sk-a')
  await secrets.set(CORE, keyOf(two), 'sk-b')
  refuse = new Set()
  const ledger = new Store(':memory:')

  // Input tokens can be counted before sending and output tokens cannot, so an unbounded
  // billed call is a cost nobody bounded. It fails here, loudly, rather than at the bill —
  // and not as a rung failure, because a caller that can reach a paid model and did not say
  // what it will pay for is a bug in that caller.
  await expect(
    send([{ model: cheapPaid, provider: two }], { messages: asked('hello') }, ledger, secrets),
  ).rejects.toThrow(/maxTokens/)

  // A free call needs no bound and does not get one. There is nothing there to bound.
  const free = await send([{ model: freeText, provider: one }], { messages: asked('hello') }, ledger, secrets)
  expect(free.model.id).toBe('free/text')
  ledger.close()
})

// Where paid fires. Two rules, and each is defensible in one sentence — which is the test for
// whether a routing rule should exist at all.
//
//   tired      the free tiers are spent. Local is slower and can do this, so it goes first.
//   incapable  free is right here and cannot do the job. Local is weaker than free and will
//              not do it either, so there is nothing to try before paying.
//
// These tests drive the shape local sits in once it is a rung in the cloud cascade: a T0 row
// in the catalog against a provider that needs no key. The rules need nothing else to change.

/** A model on this machine, reached the way the cascade will reach it. */
const onThisMachine = (over: Partial<Model> = {}): Model =>
  model({ id: 'qwen3:8b', tier: 'T0', provider: 'ollama', supportsTools: true, ...over })

/** A world whose cloud pool includes this machine, plus one paid rung behind it. */
const withLocal = (local: Model, over: Partial<World> = {}): World =>
  world({
    models: [freeTools, local, cheapPaid],
    local: [],
    rungs: [remaining(store, alpha), remaining(store, beta), remaining(store, OLLAMA)],
    ...over,
  })

test('free tired: local is tried before paid', () => {
  // Alpha has used its day, so the free hosted rung is gone. Nothing is wrong with the work —
  // there is just none of the free allowance left, and the slow helper in the house is next.
  const ledger = new Store(':memory:')
  for (let i = 0; i < alpha.rpd!; i++) sent(ledger, alpha, noon + i * 61_000)
  const at = noon + alpha.rpd! * 61_000
  const drained = withLocal(onThisMachine(), {
    rungs: [remaining(ledger, alpha, at), remaining(ledger, beta, at), remaining(ledger, OLLAMA, at)],
  })

  expect(ids(route({ messages: asked('hello'), tools: [{ name: 'fs.list' }] }, pins(), drained))).toEqual([
    'qwen3:8b',
    'paid/small',
  ])
  ledger.close()
})

test('free incapable: paid fires now, and local is not tried', () => {
  // Nothing free can use tools, and the model on this machine cannot either. It fails the
  // same filter for the same reason, so it is not a candidate and there is nothing between
  // the request and the bill.
  const mouths = withLocal(onThisMachine({ supportsTools: false }), {
    models: [model({ id: 'free/chat', tier: 'T1' }), onThisMachine({ supportsTools: false }), cheapPaid],
  })

  expect(ids(route({ messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }, pins(), mouths))).toEqual([
    'paid/small',
  ])
})

test('a paid model no better than the free one that ran out is not bought', () => {
  // The worst outcome available here: money spent, and nothing bought with it. Waiting for a
  // free tier to reset costs nothing, so the refusal says that rather than reaching for the
  // same answer at a price.
  const sidegrade = model({ id: 'paid/same', tier: 'T2', priceIn: 0.2, supportsTools: true, provider: 'beta' })
  const ledger = new Store(':memory:')
  for (let i = 0; i < alpha.rpd!; i++) sent(ledger, alpha, noon + i * 61_000)
  const at = noon + alpha.rpd! * 61_000
  const drained = world({
    models: [freeTools, sidegrade],
    local: [],
    rungs: [remaining(ledger, alpha, at), remaining(ledger, beta, at)],
  })

  expect(ids(route({ messages: asked('hello'), tools: [{ name: 'fs.list' }] }, pins(), drained))).toEqual([
    'the free models are used up, and every paid model here is no better than the one that ran out — wait for the free tiers to reset, or connect a provider with something stronger',
  ])

  // Frontier is above free by definition, which is what the tier ladder is for — so the same
  // spent day with something genuinely better behind it does get reached.
  const better = world({
    models: [freeTools, frontier],
    local: [],
    rungs: [remaining(ledger, alpha, at), remaining(ledger, beta, at)],
  })
  expect(ids(route({ messages: asked('hello'), tools: [{ name: 'fs.list' }] }, pins(), better))).toEqual([
    'paid/frontier',
  ])

  // And somebody who typed the words is not argued with: the rule is about a router
  // spending on its own.
  expect(
    ids(route({ messages: asked('hello'), tools: [{ name: 'fs.list' }] }, pins({ spend: 'paid' }), drained)),
  ).toEqual(['paid/same'])
  ledger.close()
})

test('a rung that answers with nothing is not an answer, and the next one gets its turn', async () => {
  /**
   * Found by attaching a picture to a real Alexia, and it was never about pictures.
   *
   * The free tier carries rows that are not chat models — a content-safety classifier, a
   * withdrawn preview, an alias pointing at nothing. Measured, on the real catalog: three of
   * them answered `200`, streamed zero tokens and closed, **for a typed sentence as much as
   * for an image**. Every check passed: no throw, no error status, a `Message` with an empty
   * `content`. So `send` returned it, the loop ended `answered`, and the person got an empty
   * bubble after a hundred seconds with nothing anywhere saying what had happened.
   *
   * What the image filter did was narrow the pool to a few hundred rows and put three of
   * those at the top — turning a fault that had always been there into the ordinary case.
   */
  const secrets = memorySecrets()
  const one = { ...alpha, baseUrl: at }
  const two = { ...beta, baseUrl: at }
  await secrets.set(CORE, keyOf(one), 'sk-a')
  await secrets.set(CORE, keyOf(two), 'sk-b')

  refuse = new Set()
  mute = new Set(['free/text'])
  gated = new Set()
  const ledger = new Store(':memory:')

  const answer = await send(
    [
      { model: freeText, provider: one },
      { model: cheapPaid, provider: two },
    ],
    { messages: asked('hello'), maxTokens: 200 },
    ledger,
    secrets,
    {},
  )

  expect(answer.model.id).toBe(cheapPaid.id)
  expect(answer.message.content).toBe('here')
  // And the silent one is not billed for having said nothing.
  expect(ledger.callsIn('')).not.toContain(freeText.id)
  mute = new Set()
  ledger.close()
})

test('the last rung is allowed to be the empty one, because a blank beats a crash', async () => {
  // The other side of it. Falling through the *whole* plan on an empty answer would turn a
  // model having a quiet moment into a task that failed outright — so the last rung answers
  // whatever it said, and the caller sees an empty reply rather than an exception.
  const secrets = memorySecrets()
  const one = { ...alpha, baseUrl: at }
  await secrets.set(CORE, keyOf(one), 'sk-a')

  refuse = new Set()
  mute = new Set(['free/text'])
  const ledger = new Store(':memory:')
  const answer = await send([{ model: freeText, provider: one }], { messages: asked('hello') }, ledger, secrets, {})
  expect(answer.message.content).toBe('')
  mute = new Set()
  ledger.close()
})

test('a model gated to somebody else is a rung failure, not the end of the task', async () => {
  // Real, from the free tier: *"inkling:free is only available on agentic harnesses"*. A gate
  // on one row of somebody's catalog used to throw and end a task that four hundred other
  // models could have answered.
  const secrets = memorySecrets()
  const one = { ...alpha, baseUrl: at }
  const two = { ...beta, baseUrl: at }
  await secrets.set(CORE, keyOf(one), 'sk-a')
  await secrets.set(CORE, keyOf(two), 'sk-b')

  refuse = new Set()
  mute = new Set()
  gated = new Set(['free/text'])
  const ledger = new Store(':memory:')

  const answer = await send(
    [
      { model: freeText, provider: one },
      { model: cheapPaid, provider: two },
    ],
    { messages: asked('hello'), maxTokens: 200 },
    ledger,
    secrets,
    {},
  )
  expect(answer.model.id).toBe(cheapPaid.id)
  gated = new Set()
  ledger.close()
})

test('a model nobody is serving right now is a rung failure, not the end of the task', async () => {
  // Real, from AI Horde: *"Model None not known!"*, a 406 for a row whose volunteer had gone
  // offline. It used to throw and end a first message with more of the floor still behind it.
  const secrets = memorySecrets()
  const one = { ...alpha, baseUrl: at }
  const two = { ...beta, baseUrl: at }
  await secrets.set(CORE, keyOf(one), 'sk-a')
  await secrets.set(CORE, keyOf(two), 'sk-b')

  refuse = new Set()
  mute = new Set()
  gated = new Set()
  unserved = new Set(['free/text'])
  const ledger = new Store(':memory:')

  const answer = await send(
    [
      { model: freeText, provider: one },
      { model: cheapPaid, provider: two },
    ],
    { messages: asked('hello'), maxTokens: 200 },
    ledger,
    secrets,
    {},
  )
  expect(answer.model.id).toBe(cheapPaid.id)
  unserved = new Set()
  ledger.close()
})

// ---- D155: a failure is classified once, and the plan decides how far it walks ------------

/** Two providers pointed at the scripted server, both with keys, and a fresh ledger. */
const scripted = async (): Promise<{ one: Provider; two: Provider; keys: ReturnType<typeof memorySecrets>; ledger: Store }> => {
  const keys = memorySecrets()
  const one = { ...alpha, baseUrl: at }
  const two = { ...beta, baseUrl: at }
  await keys.set(CORE, keyOf(one), 'sk-a')
  await keys.set(CORE, keyOf(two), 'sk-b')
  refuse = new Set()
  mute = new Set()
  gated = new Set()
  unserved = new Set()
  called.length = 0
  return { one, two, keys, ledger: new Store(':memory:') }
}

const free = (id: string, over: Partial<Model> = {}): Model => model({ id, name: id, tier: 'T1', ...over })

test('no credit is the next rung’s turn in Automatic, and the switch is said in one line', async () => {
  // `402` used to throw and end the answer with every other model untried.
  const { one, two, keys, ledger } = await scripted()
  behave = new Map([['free/broke', { status: 402, body: 'Insufficient credits' }]])
  const notes: string[] = []

  const answer = await send(
    [
      { model: free('free/broke'), provider: one },
      { model: free('free/fine', { provider: 'beta' }), provider: two },
    ],
    { messages: asked('hello') },
    ledger,
    keys,
    { onNote: (line) => notes.push(line), onDelta: () => undefined },
  )
  expect(answer.model.id).toBe('free/fine')
  expect(notes).toEqual(['There is no Alpha credit to pay for free/broke — this answer is from free/fine.'])
  ledger.close()
})

test('one model that fails stops, with the model and the reason in words', async () => {
  const { one, keys, ledger } = await scripted()
  behave = new Map([['free/broke', { status: 402, body: 'Insufficient credits' }]])
  // A plan of one is what a pin routes to, so there is nothing to walk to.
  await expect(send([{ model: free('free/broke'), provider: one }], { messages: asked('hello') }, ledger, keys)).rejects.toMatchObject({
    status: 402,
    message: 'There is no Alpha credit to pay for free/broke.',
  })
  ledger.close()
})

test('a list that fails all the way down stops at its end, and the model outside it is never asked', async () => {
  const { one, two, keys, ledger } = await scripted()
  const first = free('free/first', { supportsTools: true })
  const second = free('free/second', { supportsTools: true, provider: 'beta' })
  const outside = free('free/outside', { supportsTools: true })
  behave = new Map<string, { status: number; body?: string } | 'dies' | 'hangs' | 'cut'>([
    ['free/first', { status: 429 }],
    ['free/second', { status: 404, body: 'No endpoints found' }],
  ])
  const place: World = world({ models: [first, second, outside], rungs: [remaining(ledger, one), remaining(ledger, two)] })

  const verdict = route({ messages: asked('hello') }, pins({ order: ['free/first', 'free/second'] }), place)
  expect(verdict).toMatchObject({ ok: true, mode: 'sequence' })
  const plan = verdict.ok ? verdict.choices.map((c) => ({ ...c, provider: c.provider.id === 'alpha' ? one : two })) : []

  await expect(send(plan, { messages: asked('hello') }, ledger, keys)).rejects.toThrow(
    'free/first is rate-limited right now, and free/second is no longer offered by Beta.',
  )
  expect(called).toEqual(['free/first', 'free/second'])
  ledger.close()
})

test('a stream that dies halfway starts again on the next rung, and the half is thrown away', async () => {
  const { one, two, keys, ledger } = await scripted()
  behave = new Map([['free/dies', 'dies']])
  const shown: string[] = []

  const answer = await send(
    [
      { model: free('free/dies'), provider: one },
      { model: free('free/fine', { provider: 'beta' }), provider: two },
    ],
    { messages: asked('hello') },
    ledger,
    keys,
    {
      onDelta: (text) => shown.push(text),
      // What the shell does with it: the half-written bubble is cleared.
      onRestart: () => (shown.length = 0),
      onNote: (line) => shown.push(`[${line}]`),
    },
  )
  expect(answer.model.id).toBe('free/fine')
  expect(answer.message.content).toBe('here')
  expect(shown).toEqual(['[free/dies stopped answering partway through — this answer is from free/fine.]', 'here'])
  ledger.close()
})

test('a provider that never answers is given up on at its patience, and the next rung asked', async () => {
  const { one, two, keys, ledger } = await scripted()
  behave = new Map([['free/silent', 'hangs']])
  // A tenth of a second standing in for the thirty every row now gets by default.
  const impatient = { ...one, timeoutMs: 100 }

  const answer = await send(
    [
      { model: free('free/silent'), provider: impatient },
      { model: free('free/fine', { provider: 'beta' }), provider: two },
    ],
    { messages: asked('hello') },
    ledger,
    keys,
  )
  expect(answer.model.id).toBe('free/fine')
  ledger.close()
})

test('a refused key skips every model on that provider, and only that provider', async () => {
  const { one, two, keys, ledger } = await scripted()
  behave = new Map([['free/a1', { status: 401, body: 'invalid api key' }]])
  const notes: string[] = []

  const answer = await send(
    [
      { model: free('free/a1'), provider: one },
      { model: free('free/a2'), provider: one },
      { model: free('free/b1', { provider: 'beta' }), provider: two },
    ],
    { messages: asked('hello') },
    ledger,
    keys,
    { onNote: (line) => notes.push(line) },
  )
  // Every rung on alpha would have said the same thing, so the second was not asked.
  expect(called).toEqual(['free/a1', 'free/b1'])
  expect(answer.model.id).toBe('free/b1')
  expect(notes).toEqual(['Your Alpha key was refused — this answer is from free/b1.'])
  ledger.close()
})

test('a keyless provider saying 401 is one model wanting a key, not the provider gone', async () => {
  // A keyless floor answers most of its list anonymously and a few models only with a key.
  const { keys, ledger } = await scripted()
  const floor: Provider = { id: 'floor', name: 'Floor', baseUrl: at, auth: 'optional' }
  behave = new Map([['floor/keyed', { status: 401, body: 'missing_api_key' }]])

  const answer = await send(
    [
      { model: free('floor/keyed', { provider: 'floor' }), provider: floor },
      { model: free('floor/open', { provider: 'floor' }), provider: floor },
    ],
    { messages: asked('hello') },
    ledger,
    keys,
  )
  expect(answer.model.id).toBe('floor/open')
  ledger.close()
})

test('a conversation too long for one model is only tried on a bigger window', async () => {
  const { one, two, keys, ledger } = await scripted()
  behave = new Map([['free/32k', { status: 400, body: "This model's maximum context length is 32768 tokens" }]])
  const plan = [
    { model: free('free/32k'), provider: one },
    // The same window would refuse the same way, and a smaller one worse.
    { model: free('free/also-32k', { provider: 'beta' }), provider: two },
    { model: free('free/8k', { provider: 'beta', context: 8_192 }), provider: two },
    { model: free('free/200k', { provider: 'beta', context: 200_000 }), provider: two },
  ]
  const answer = await send(plan, { messages: asked('hello') }, ledger, keys)
  expect(answer.model.id).toBe('free/200k')
  expect(called).toEqual(['free/32k', 'free/200k'])

  // And with nothing bigger left, the stop says so rather than blaming the model.
  called.length = 0
  await expect(send(plan.slice(0, 3), { messages: asked('hello') }, ledger, keys)).rejects.toThrow(
    'This conversation is too long for free/32k. Nothing left to try reads more than that — start a new chat.',
  )
  ledger.close()
})

test('a model retired, a connection refused, a server error: each is the next rung’s turn', async () => {
  const { one, two, keys, ledger } = await scripted()
  behave = new Map<string, { status: number; body?: string } | 'dies' | 'hangs' | 'cut'>([
    ['free/retired', { status: 404 }],
    ['free/broken', { status: 500 }],
  ])
  // Nothing listens on port 1, which is what a network that is not there looks like from here.
  const nowhere: Provider = { ...one, id: 'nowhere', name: 'Nowhere', baseUrl: 'http://127.0.0.1:1/v1' }
  await keys.set(CORE, keyOf(nowhere), 'sk-n')

  const answer = await send(
    [
      { model: free('free/retired'), provider: one },
      { model: free('free/unreached', { provider: 'nowhere' }), provider: nowhere },
      { model: free('free/broken'), provider: one },
      { model: free('free/fine', { provider: 'beta' }), provider: two },
    ],
    { messages: asked('hello') },
    ledger,
    keys,
  )
  expect(answer.model.id).toBe('free/fine')
  ledger.close()
})

test('a free answer cut off at its ceiling is the next rung’s turn, and a paid one is not bought twice', async () => {
  const { one, two, keys, ledger } = await scripted()
  behave = new Map<string, { status: number; body?: string } | 'dies' | 'hangs' | 'cut'>([
    ['free/cut', 'cut'],
    ['paid/cut', 'cut'],
  ])
  const walked = await send(
    [
      { model: free('free/cut'), provider: one },
      { model: free('free/fine', { provider: 'beta' }), provider: two },
    ],
    { messages: asked('hello') },
    ledger,
    keys,
  )
  expect(walked.model.id).toBe('free/fine')

  // Billed, and the next paid model would end at the same ceiling for a second bill. So the
  // cut answer comes back as one, and the caller — Adapt, say — decides what it is worth.
  const billed = await send(
    [
      { model: model({ ...cheapPaid, id: 'paid/cut' }), provider: two },
      { model: frontier, provider: two },
    ],
    { messages: asked('hello'), maxTokens: 200 },
    ledger,
    keys,
  )
  expect(billed).toMatchObject({ cut: true, message: { content: 'half' } })
  expect(called).not.toContain('paid/frontier')
  ledger.close()
})

test('the stop button is not a failure, so it walks nowhere', async () => {
  const { one, two, keys, ledger } = await scripted()
  behave = new Map([['free/silent', 'hangs']])
  const stop = new AbortController()
  const asking = send(
    [
      { model: free('free/silent'), provider: one },
      { model: free('free/fine', { provider: 'beta' }), provider: two },
    ],
    { messages: asked('hello'), signal: stop.signal },
    ledger,
    keys,
  )
  setTimeout(() => stop.abort(), 50)
  await expect(asking).rejects.not.toBeInstanceOf(ProviderError)
  expect(called).toEqual(['free/silent'])
  ledger.close()
})

test('a long stop lists three reasons and counts the rest', () => {
  const choice = (id: string): Choice => ({ model: free(id), provider: alpha })
  const failures = ['a', 'b', 'c', 'd', 'e'].map((id) => failed(new ProviderError(429, 'slow down'), choice(id))!)
  expect(stopped(failures)).toBe(
    'a is rate-limited right now, b is rate-limited right now, c is rate-limited right now, and 2 more could not answer either.',
  )
  // Nothing about a provider failing is a reason to hide the monthly cap behind it.
  expect(stopped(failures.slice(0, 1), 'the monthly cap is reached — raise it in settings, or use a free model')).toBe(
    'a is rate-limited right now. The monthly cap is reached — raise it in settings, or use a free model.',
  )
})

// ---- Best to worst (D159) -------------------------------------------------------------------
//
// `weekly` was the only thing ordering the free tier, and only OpenRouter publishes it, so
// without an OpenRouter key every free model tied and `kilo-auto/free` — a router — came first.

const work = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }
const hands = (id: string, over: Partial<Model> = {}): Model => model({ id, tier: 'T1', supportsTools: true, ...over })
const where = (verdict: ReturnType<typeof route>): string[] =>
  verdict.ok ? verdict.choices.map((c) => `${c.model.id}@${c.provider.id}`) : [verdict.why]
/** Failures of one model on one provider, each so many minutes ago. */
const failures = (model: string, provider: string, ...minutesAgo: number[]): Strike[] =>
  minutesAgo.map((ago) => ({ model, provider, at: Date.now() - ago * 60_000 }))

test('a model that failed here lately goes behind the ones that did not, and comes back as it ages', () => {
  const best = hands('free/best', { weekly: 9_000_000 })
  const next = hands('free/next', { weekly: 10 })
  const struck = (...minutesAgo: number[]): World =>
    world({ models: [best, next], strikes: failures('free/best', 'alpha', ...minutesAgo) })

  expect(ids(route(work, pins(), struck()))).toEqual(['free/best', 'free/next'])
  // model_plan.md §2's acceptance: a model that timed out twice in the last hour is not first.
  expect(ids(route(work, pins(), struck(50, 10)))).toEqual(['free/next', 'free/best'])
  // One failure counts half after an hour and is rounded away, so it is first again — a rate
  // limit ends and a free tier resets, and nothing here writes a model off for good.
  expect(ids(route(work, pins(), struck(70)))).toEqual(['free/best', 'free/next'])
  // Two together count one after an hour, and still sink it.
  expect(ids(route(work, pins(), struck(70, 70)))).toEqual(['free/next', 'free/best'])
  expect(STRIKE_HALF_LIFE).toBe(60 * 60 * 1000)

  // What failed orders a plan, and never empties one: the struck model is still asked last,
  // and a pin on it is still the pin.
  expect(ids(route(work, pins({ model: 'free/best' }), struck(1, 1, 1)))).toEqual(['free/best'])
  // Nor does it reorder a list somebody wrote.
  expect(ids(route(work, pins({ order: ['free/best', 'free/next'] }), struck(1, 1, 1)))).toEqual(['free/best', 'free/next'])
})

test('a failure is about one model on one provider, so the same model elsewhere is asked first', () => {
  const floor: Provider = { id: 'floor', name: 'Floor', baseUrl: 'http://127.0.0.1:3', auth: 'optional' }
  const both = (strikes: Strike[] = []): World =>
    world({
      models: [hands('same/model', { provider: 'floor' }), hands('same/model')],
      rungs: [remaining(store, floor), remaining(store, alpha)],
      strikes,
    })
  // Your key before the floor, as the ladder says…
  expect(where(route(work, pins(), both()))).toEqual(['same/model@alpha', 'same/model@floor'])
  // …until your key's copy has just failed twice.
  expect(where(route(work, pins(), both(failures('same/model', 'alpha', 2, 1))))).toEqual([
    'same/model@floor',
    'same/model@alpha',
  ])
})

test('a pinned model on two providers is asked on your key, not whichever the catalog read first, and is still one choice', () => {
  // Measured on this machine: each of the owner's Nemotrons is on Kilo's keyless floor and on
  // OpenRouter, Kilo first in the file — so a pin took the floor while a key sat in the keychain.
  const floor: Provider = { id: 'floor', name: 'Floor', baseUrl: 'http://127.0.0.1:3', auth: 'optional' }
  const both = (strikes: Strike[] = []): World =>
    world({
      models: [hands('same/model', { provider: 'floor' }), hands('other/model', { provider: 'floor' }), hands('same/model')],
      rungs: [remaining(store, floor), remaining(store, alpha)],
      strikes,
    })
  const pinned = route(work, pins({ model: 'same/model' }), both())
  expect(pinned.mode).toBe('pinned')
  // One choice: a pin never falls back, not even to the same model on the other provider.
  expect(where(pinned)).toEqual(['same/model@alpha'])
  // Picked the way a list picks between one model's providers, so a copy that just failed
  // hands the pin to the other copy — of the same model, which is still what was chosen.
  expect(where(route(work, pins({ model: 'same/model' }), both(failures('same/model', 'alpha', 1))))).toEqual([
    'same/model@floor',
  ])
})

test('a router is asked after every model that is one model, and it can still be pinned or listed', () => {
  // Priced at zero and the busiest thing in the catalog, so nothing but being a router sinks it.
  const lottery = hands('kilo-auto/free', { name: 'Auto Free', weekly: 900_000_000_000 })
  const named = hands('openrouter/free', { name: 'Free Models Router' })
  const real = hands('vendor/real')
  const tiny = hands('vendor/tiny-2.6b')
  const catalog = world({ models: [lottery, named, tiny, real] })

  // Behind even a 2.6B: that one is one model somebody can judge, and a router is a
  // different model on every request, that 2.6B included.
  expect(ids(route(work, pins(), catalog))).toEqual(['vendor/real', 'vendor/tiny-2.6b', 'kilo-auto/free', 'openrouter/free'])
  expect(ids(route(work, pins({ model: 'kilo-auto/free' }), catalog))).toEqual(['kilo-auto/free'])
  expect(ids(route(work, pins({ order: ['openrouter/free', 'vendor/real'] }), catalog))).toEqual([
    'openrouter/free',
    'vendor/real',
  ])
})

test('a size read from the id: under 7B sinks, and unknown sits in the middle rather than at the bottom', () => {
  // Listed smallest first and busiest first, so neither the file nor `weekly` can be what
  // decides it.
  const tiny = hands('liquid/lfm-2.5-2.6b:free', { weekly: 9_000_000_000 })
  const unsaid = hands('poolside/laguna-s-2.1:free', { weekly: 5_000_000 })
  const large = hands('nvidia/nemotron-3-super-120b-a12b:free', { weekly: 1 })
  expect(ids(route(work, pins(), world({ models: [tiny, unsaid, large] })))).toEqual([
    'nvidia/nemotron-3-super-120b-a12b:free',
    'poolside/laguna-s-2.1:free',
    'liquid/lfm-2.5-2.6b:free',
  ])

  // An order and never a filter: planning still reaches a hosted 2.6B when it is all there
  // is, because only a size the runner itself reports keeps a model off planning (D62).
  const planning = { ...work, messages: asked('refactor the notes module') }
  expect(ids(route(planning, pins(), world({ models: [tiny] })))).toEqual(['liquid/lfm-2.5-2.6b:free'])
})

test('a keyless provider with your key in it ranks with your keys, and its bubble says so', () => {
  const kilo: Provider = { id: 'floor', name: 'Floor', baseUrl: 'http://127.0.0.1:3', auth: 'optional' }
  const onFloor = hands('floor/model', { provider: 'floor', weekly: 900 })
  const onKey = hands('keyed/model', { weekly: 1 })
  const floorRung = remaining(store, kilo)

  // No key in it: the floor, behind a keyed tier however much less that one is used.
  const stranger = route(work, pins(), world({ models: [onFloor, onKey], rungs: [remaining(store, alpha), floorRung] }))
  expect(ids(stranger)).toEqual(['keyed/model', 'floor/model'])
  expect(stranger.ok && bubble(stranger.choices[1]!).says).toBe('free floor, still capable')

  // A paid-up account on the same provider is one of your keys, and the world's usage decides.
  const paidUp = route(
    work,
    pins(),
    world({ models: [onFloor, onKey], rungs: [remaining(store, alpha), { ...floorRung, keyed: true }] }),
  )
  expect(ids(paidUp)).toEqual(['floor/model', 'keyed/model'])
  expect(paidUp.ok && bubble(paidUp.choices[0]!).says).toBe('ready for anything')
})

test('/best turns the money round, and leaves what failed and what is a router at the bottom', () => {
  const lottery = hands('kilo-auto/free', { name: 'Auto Free' })
  const catalog = world({
    models: [lottery, freeTools, cheapPaid, frontier],
    strikes: failures('paid/frontier', 'beta', 1),
  })
  // Walking the whole list backwards put the model that failed a minute ago, and a router,
  // at the top of the strongest-first list.
  expect(ids(route({ messages: asked('hello'), tools: [{ name: 'fs.list' }] }, pins({ prefer: 'best' }), catalog))).toEqual([
    'paid/small',
    'paid/frontier',
    'free/tools',
    'kilo-auto/free',
  ])
})

test('with no OpenRouter key, Automatic on this machine’s catalog starts with a real model of a real size', () => {
  // The rows `model_plan.md` §2 measured, cut to what decides the order: Kilo's free list in
  // Kilo's own order, and OpenRouter's rows for the same models with the figures OpenRouter
  // published (2026-09-15 cache). Before D159 the first choice here was `kilo-auto/free`.
  const kiloGateway: Provider = { id: 'kilo-gateway', name: 'Kilo Gateway', baseUrl: 'http://127.0.0.1:4', auth: 'optional' }
  const openrouter: Provider = { id: 'openrouter', name: 'OpenRouter', baseUrl: 'http://127.0.0.1:5' }
  const kilo = (id: string, name: string): Model => hands(id, { name, provider: 'kilo-gateway', context: 262_144 })
  const lent = (id: string, weekly: number): Model => hands(id, { provider: 'openrouter', context: 262_144, weekly })
  const models = borrow([
    kilo('kilo-auto/free', 'Auto Free'),
    kilo('poolside/laguna-s-2.1:free', 'Poolside: Laguna S 2.1 (free)'),
    kilo('nvidia/nemotron-3-ultra-550b-a55b:free', 'NVIDIA: Nemotron 3 Ultra (free)'),
    kilo('liquid/lfm-2.5-2.6b:free', 'LiquidAI: LFM2.5-2.6B (free)'),
    kilo('nvidia/nemotron-3.5-lightning:free', 'NVIDIA: Nemotron 3.5 Lightning (free)'),
    kilo('nvidia/nemotron-3-super-120b-a12b:free', 'NVIDIA: Nemotron 3 Super (free)'),
    kilo('openrouter/free', 'OpenRouter Free Models Router'),
    lent('google/gemma-4-31b-it:free', 391_965_209_752),
    lent('poolside/laguna-s-2.1:free', 69_326_928_584),
    lent('nvidia/nemotron-3.5-lightning:free', 51_038_703_166),
    lent('nvidia/nemotron-3-ultra-550b-a55b:free', 31_889_512_209),
    lent('nvidia/nemotron-3-super-120b-a12b:free', 10_043_068_411),
    lent('liquid/lfm-2.5-2.6b:free', 2_056_029),
    hands('openrouter/free', { name: 'Free Models Router', provider: 'openrouter', context: 200_000 }),
  ])
  const floorOnly = route(work, pins(), world({ models, rungs: [remaining(store, kiloGateway)] }))
  expect(ids(floorOnly)).toEqual([
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'poolside/laguna-s-2.1:free',
    'nvidia/nemotron-3.5-lightning:free',
    'liquid/lfm-2.5-2.6b:free',
    'kilo-auto/free',
    'openrouter/free',
  ])

  // With an OpenRouter key the answer is the one the plan found already worked, and the keyless
  // copies of the same models follow your key's.
  const keyed = route(work, pins(), world({ models, rungs: [remaining(store, kiloGateway), remaining(store, openrouter)] }))
  expect(where(keyed).slice(0, 3)).toEqual([
    'google/gemma-4-31b-it:free@openrouter',
    'nvidia/nemotron-3-ultra-550b-a55b:free@openrouter',
    'nvidia/nemotron-3-super-120b-a12b:free@openrouter',
  ])
  // A router is last whoever's key it is behind — and among the routers, your key still first.
  expect(where(keyed).slice(-3)).toEqual(['openrouter/free@openrouter', 'kilo-auto/free@kilo-gateway', 'openrouter/free@kilo-gateway'])
})

test('what failed is remembered on this machine; a refused key and a conversation too long are not', async () => {
  const { one, two, keys, ledger } = await scripted()
  const three: Provider = { ...alpha, id: 'gamma', name: 'Gamma', baseUrl: at }
  await keys.set(CORE, keyOf(three), 'sk-c')
  behave = new Map([
    ['free/limited', { status: 429, body: 'slow down' }],
    ['free/32k', { status: 400, body: "This model's maximum context length is 32768 tokens" }],
    ['free/refused', { status: 401, body: 'invalid api key' }],
  ])
  mute = new Set(['free/mute'])

  const answer = await send(
    [
      { model: free('free/limited'), provider: one },
      { model: free('free/mute'), provider: one },
      { model: free('free/32k', { provider: 'beta', context: 32_768 }), provider: two },
      { model: free('free/refused', { provider: 'beta', context: 200_000 }), provider: two },
      { model: free('free/fine', { provider: 'gamma', context: 200_000 }), provider: three },
    ],
    { messages: asked('hello') },
    ledger,
    keys,
  )
  expect(answer.model.id).toBe('free/fine')
  // The rate limit and the empty answer are about those models. The key is the provider's, and
  // the window was the conversation's — neither says anything about how a model is doing.
  expect(ledger.strikes().map((one) => `${one.model}@${one.provider}`)).toEqual(['free/limited@alpha', 'free/mute@alpha'])
  behave = new Map()
  ledger.close()
})

test('a model a gateway only kept alive is named with the time it was given, and is the model’s failure (D163)', () => {
  const gateway: Provider = { id: 'kilo-gateway', name: 'Kilo Gateway', baseUrl: 'http://127.0.0.1:4', auth: 'optional' }
  const kept = failed(new ProviderError(504, 'kept', 'kept'), { model: free('nvidia/ultra', { name: 'Nemotron 3 Ultra' }), provider: gateway })
  expect(kept).toMatchObject({ reach: 'model', outcome: 'slow' })
  expect(kept?.says).toBe('Nemotron 3 Ultra did not answer in 120 seconds, though Kilo Gateway kept the connection open')
})

test('a switch into a paid model is said twice: the charge line in its place, and the switch as an event (§4 G)', async () => {
  const { one, two, keys, ledger } = await scripted()
  refuse = new Set(['free/text'])
  const switches: Switch[] = []
  const paidLines: string[] = []
  const notes: string[] = []
  const answer = await send(
    [
      { model: freeText, provider: one },
      { model: cheapPaid, provider: two },
    ],
    { messages: asked('hello'), maxTokens: 200 },
    ledger,
    keys,
    { onNote: (line) => notes.push(line), onSwitch: (event) => switches.push(event), onPaid: (line) => paidLines.push(line) },
  )
  expect(answer.model.id).toBe('paid/small')
  expect(paidLines).toEqual(['The free models are used up, so this one goes to paid/small, which costs money.'])
  // Where the switch has a place of its own it is still said, rather than folded into the charge.
  expect(switches.map((one) => [one.from, one.to])).toEqual([[['free/text'], 'paid/small']])
  expect(notes).toEqual([])
  refuse = new Set()
  ledger.close()
})
