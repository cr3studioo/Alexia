// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, test } from 'vitest'
import type { Model } from '../src/catalog.js'
import { SEEDED } from '../src/catalog.js'
import { remaining, sent, usable } from '../src/pool.js'
import { anonymous, keyOf, PROVIDERS, type Provider } from '../src/provider.js'
import { OLLAMA } from '../src/ollama.js'
import { bubble, MODES, route, send, shapeOf, type Choice, type Pins, type World } from '../src/router.js'
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

test('the shortlist can move this machine up, because that is somebody typing it', () => {
  // The rule above is about a default reaching for local first, not about arguing with a
  // person who dragged their own model to the top. The group still wins — free before paid —
  // and inside it the list the user wrote themselves is read before the local rule.
  const work = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }
  const installed = world({ local: [localSmall] })
  expect(ids(route(work, pins({ order: ['qwen3:8b'] }), installed))).toEqual([
    'qwen3:8b',
    'free/tools',
    'paid/small',
    'paid/frontier',
  ])
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

  // Frontier named first, and it still sorts behind every free model — because it is paid.
  expect(ids(route(work, pins({ order: ['paid/frontier'] }), world()))).toEqual([
    'free/tools',
    'paid/frontier',
    'paid/small',
  ])

  // Within the paid group it is the whole point: the dearer one first because it was asked
  // for, ahead of the rule that would otherwise have chosen for you.
  expect(ids(route(work, pins({ spend: 'paid', order: ['paid/frontier'] }), world()))).toEqual([
    'paid/frontier',
    'paid/small',
  ])

  // And an empty list is the behaviour this screen had before anybody touched it, which is
  // what makes the shortlist optional rather than a form to fill in.
  expect(ids(route(work, pins({ order: [] }), world()))).toEqual(ids(route(work, pins(), world())))
})

test('a model that has left the catalog does not take the order with it', () => {
  const work = { messages: asked('sort my downloads'), tools: [{ name: 'fs.list' }] }
  // `Infinity - Infinity` is `NaN`, which `Array.sort` reads as *equal* in every direction at
  // once — so the unlisted rows would have come back in whatever order the engine felt like.
  // They tie on `order.length` instead, and fall through to the rules underneath.
  expect(ids(route(work, pins({ order: ['gone/yesterday', 'also/gone'] }), world()))).toEqual([
    'free/tools',
    'paid/small',
    'paid/frontier',
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
