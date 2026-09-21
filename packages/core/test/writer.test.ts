// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import type { Model } from '../src/catalog.js'
import type { Health, Judgement } from '../src/health.js'
import { MODES, route, wantsCapable, type Pins, type World } from '../src/router.js'
import type { Provider } from '../src/provider.js'

/**
 * **M8-1: `modelPreferences` and `min_tier` are honoured**, and `plan-personality.md` §1's
 * first two sub-items — *never a router, and never a model Alexia doubts*.
 *
 * Two fields a plugin author sets and core ignored. The personality adapter asked for
 * `intelligencePriority: 0.8` under a comment about *a rung that can write*, and declared
 * `min_tier: "T1"` in its manifest, from the day each was written — and both ran on whatever
 * the user's pin said. Nothing failed and nothing logged, which is why this is the contract
 * being wrong about itself rather than a missing feature.
 *
 * `serve.writer.test.ts` holds the other half: the two fields travelling from a real
 * manifest and a real `sampling/createMessage` into the router, and a button press spending
 * like the run it is (G13, D156).
 */

const alpha: Provider = { id: 'alpha', name: 'Alpha', baseUrl: 'http://127.0.0.1:1', rpm: 100, rpd: 100 }
const beta: Provider = { id: 'beta', name: 'Beta', baseUrl: 'http://127.0.0.1:2', rpm: 100, rpd: 100 }

const model = (over: Partial<Model> & Pick<Model, 'id'>): Model => ({
  name: over.id,
  provider: 'alpha',
  tier: 'T1',
  priceIn: 0,
  priceOut: 0,
  context: 32_768,
  // Every model here can use tools, so the *hands before mouths* key never decides anything
  // below and the order under test is the one these tests are about.
  supportsTools: true,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'unknown',
  ...over,
})

/** The good free model: big, and the world sends it plenty. */
const writer = model({ id: 'vendor/writer-120b', params: 120, weekly: 9_000 })
/** A free model too small to hold a document, which is the bug that started the rebuild. */
const tiny = model({ id: 'vendor/tiny-2.6b', params: 2.6, weekly: 400 })
/** A router: a different free model each time, 2.6B included ({@link routes}, D159). */
const lottery = model({ id: 'alpha-auto/free', name: 'Alpha Auto', params: 120, weekly: 20_000 })
/** A free model this machine has doubts about, and one it has never tried. */
const shaky = model({ id: 'vendor/shaky-70b', params: 70, weekly: 8_000 })
const fresh = model({ id: 'vendor/fresh-70b', params: 70, weekly: 8_000 })
/** A paid model worth buying rather than a sidegrade: it reads four times what the free ones can. */
const strong = model({ id: 'paid/strong', provider: 'beta', tier: 'T2', priceIn: 1, priceOut: 2, context: 128_000, params: 400 })
/** A local model, for the floor `min_tier` is about. */
const here = model({ id: 'qwen3:8b', provider: 'ollama', tier: 'T0', params: 8 })

const judgement = (over: Partial<Judgement> = {}): Judgement => ({ tags: [], untested: false, doubted: false, ...over })
const health = (rows: Record<string, Judgement>): Health => new Map(Object.entries(rows))

const pins = (over: Partial<Pins> = {}): Pins => ({ placement: MODES.combined, ...over })
const world = (models: Model[], over: Partial<World> = {}): World => ({
  models: models.filter((one) => one.tier !== 'T0'),
  local: models.filter((one) => one.tier === 'T0'),
  rungs: [
    { provider: alpha, minute: Infinity, day: Infinity, month: Infinity, keyed: true },
    { provider: beta, minute: Infinity, day: Infinity, month: Infinity, keyed: true },
  ],
  // An allowance with room in it, so the price line is open and both sides of it can answer.
  today: { spent: 0, allowance: 5 },
  ...over,
})
const asked = (text: string): { role: 'user'; content: string }[] => [{ role: 'user', content: text }]
const ids = (verdict: ReturnType<typeof route>): string[] => (verdict.ok ? verdict.choices.map((c) => c.model.id) : [verdict.why])

// ---- what core reads of `modelPreferences`, and what it does not ---------------------------

test('intelligence first and meant is the whole of what core takes from modelPreferences', () => {
  // The personality adapter's own numbers, written in `plugins/persona/index.js`.
  expect(wantsCapable({ intelligencePriority: 0.8, speedPriority: 0.3, costPriority: 0.3 })).toBe(true)
  // Cheapest-first is already what this router does, so asking for it changes nothing.
  expect(wantsCapable({ costPriority: 0.9, intelligencePriority: 0.2 })).toBe(false)
  // A plugin that set all three to a half and moved on has not said anything.
  expect(wantsCapable({ intelligencePriority: 0.5, speedPriority: 0.5, costPriority: 0.5 })).toBe(false)
  // Above the other two but not meant: a nudge is not a declaration.
  expect(wantsCapable({ intelligencePriority: 0.4, costPriority: 0.1 })).toBe(false)
  // Speed is read and not acted on — nothing in the catalog says how fast a model answers —
  // so a plugin asking for speed gets the default, not a different order.
  expect(wantsCapable({ speedPriority: 0.9, intelligencePriority: 0.1 })).toBe(false)
  expect(wantsCapable({})).toBe(false)
  expect(wantsCapable()).toBe(false)
})

test('a plugin asking for intelligence and one asking for cost get different models from the same pool', () => {
  // plan.md M8-1's first acceptance. The pins permit both sides of the price line, and the
  // only thing that differs between the two calls is what the plugin declared.
  const pool = world([writer, tiny, strong])
  const mind = { messages: asked('write me a personality'), capable: true }
  const purse = { messages: asked('write me a personality') }
  expect(ids(route(mind, pins(), pool))[0]).toBe('paid/strong')
  expect(ids(route(purse, pins(), pool))[0]).toBe('vendor/writer-120b')
  // And the cheap one never reaches for money on its own: the free models come first, whole.
  expect(ids(route(purse, pins(), pool))).toEqual(['vendor/writer-120b', 'vendor/tiny-2.6b', 'paid/strong'])
})

test('best-first turns the price axis and not the rungs, which is where it differs from /best', () => {
  // Found by probing this Mac's own shape before trusting the change: one big model on the
  // owner's own key, a small one on the keyless floor, and a big one with no tools. `/best`
  // turns §8.2's rungs round as well as the money, which is right for somebody typing *the
  // strongest thing you can reach* and wrong for *write me a personality*: it chose the
  // talker, and then the floor's 7B ahead of the 550B on the key.
  const big = model({ id: 'vendor/big-550b', params: 550, weekly: 50_000 })
  const onFloor = model({ id: 'vendor/mini-7b', provider: 'beta', params: 7, weekly: 100 })
  const mouth = model({ id: 'vendor/mouth-200b', params: 200, weekly: 30_000, supportsTools: false })
  const pool: World = {
    ...world([big, onFloor, mouth]),
    // Beta answers a stranger, and nobody has pasted a key into it: the keyless floor.
    rungs: [
      { provider: alpha, minute: Infinity, day: Infinity, month: Infinity, keyed: true },
      { provider: { ...beta, auth: 'optional' }, minute: Infinity, day: Infinity, month: Infinity, keyed: false },
    ],
  }
  const order = ['vendor/big-550b', 'vendor/mini-7b', 'vendor/mouth-200b']
  expect(ids(route({ messages: asked('write me a personality'), capable: true }, pins(), pool))).toEqual(order)
  // The same order the default walks, because among free models the whole price axis ties —
  // which is the honest answer, and it is the two filters above that earn their keep there.
  expect(ids(route({ messages: asked('write me a personality') }, pins(), pool))).toEqual(order)
  // `/best` is untouched, and still turns the rungs round.
  expect(ids(route({ messages: asked('write me a personality') }, pins({ prefer: 'best' }), pool))).toEqual([
    'vendor/mouth-200b',
    'vendor/mini-7b',
    'vendor/big-550b',
  ])
})

// ---- the manifest's floor -----------------------------------------------------------------

test('a plugin whose manifest says min_tier T2 is never routed to a T0 or a T1 model', () => {
  // plan.md M8-1's second acceptance.
  const pool = world([here, writer, tiny, strong])
  expect(ids(route({ messages: asked('anything'), minTier: 'T2' }, pins(), pool))).toEqual(['paid/strong'])
  // Without the floor, the free rungs and this machine answer first, as they always did.
  expect(ids(route({ messages: asked('anything') }, pins(), pool))).toEqual([
    'vendor/writer-120b',
    'vendor/tiny-2.6b',
    'qwen3:8b',
    'paid/strong',
  ])
  // The adapter's own declaration, `min_tier: "T1"`: the hosted free models, and not this Mac.
  expect(ids(route({ messages: asked('anything'), minTier: 'T1' }, pins(), pool))).not.toContain('qwen3:8b')
})

test('a floor nothing reaches says which floor, rather than *try again shortly*', () => {
  // The honest half of honouring the field: a declaration that now removes models has to be
  // able to say it was the reason. `manifest.md` warns that a plugin demanding T3 does not
  // work for somebody with no paid key — this is what that person reads.
  const free = world([writer, tiny])
  expect(ids(route({ messages: asked('anything'), minTier: 'T3' }, pins(), free))).toEqual([
    'what asked for this needs a frontier model, and nothing you have connected is one — connect a provider that offers one',
  ])
  expect(ids(route({ messages: asked('anything'), minTier: 'T1' }, pins(), world([here])))).toEqual([
    'what asked for this needs a hosted model rather than one on this machine, and nothing you have connected is one — connect a provider that offers one',
  ])
  // And it is not said when the floor is reachable and something else is the wall: a paid
  // floor with a paid model behind a closed price line is the money wall, not this one.
  const closed = route({ messages: asked('anything'), minTier: 'T2' }, pins({ spend: 'free' }), world([writer, strong]))
  expect(ids(closed)[0]).toContain('set to free only')
})

test('a floor the spent free tiers meet asks them anyway, rather than sending somebody to connect one', () => {
  // The ledger marks both free tiers spent and this machine has a model: without the floor the
  // local one answers, as it always did. With a `T1` floor that local model is not a candidate,
  // and *connect a provider* would be said to somebody with two connected — so the ledger's
  // pre-check steps aside the way D107 says it does when honouring it leaves nothing.
  const tired: World = {
    ...world([here, writer, tiny]),
    rungs: [
      { provider: alpha, minute: Infinity, day: 0, month: Infinity, keyed: true },
      { provider: beta, minute: Infinity, day: 0, month: Infinity, keyed: true },
    ],
  }
  expect(ids(route({ messages: asked('anything') }, pins(), tired))).toEqual(['qwen3:8b'])
  expect(ids(route({ messages: asked('anything'), minTier: 'T1' }, pins(), tired))).toEqual([
    'vendor/writer-120b',
    'vendor/tiny-2.6b',
  ])
})

test('in Local mode a capable ask takes the model on this machine, rather than refusing', () => {
  // The trap `min_tier` sets for its own author, and the reason `plugins/persona` no longer
  // declares one: in Local mode the pool **is** this machine, so a `T1` floor is not *prefer a
  // hosted model*, it is *this button does not work for anybody who chose Alexia for privacy*.
  // A preference asks for the strongest thing reachable; a floor refuses everybody without one.
  const here8b = model({ id: 'qwen3:8b', provider: 'ollama', tier: 'T0', params: 8 })
  const onlyHere = { ...world([here8b]), local: [here8b], models: [] }
  const local = pins({ placement: MODES.local })
  expect(ids(route({ messages: asked('write me a personality'), capable: true }, local, onlyHere))).toEqual(['qwen3:8b'])
  expect(ids(route({ messages: asked('write me a personality'), capable: true, minTier: 'T1' }, local, onlyHere))).toEqual([
    'what asked for this needs a hosted model rather than one on this machine, and nothing you have connected is one — connect a provider that offers one',
  ])
})

// ---- a pin still wins, and the one pin that is not a pin on a model -------------------------

test('a model pin wins outright over a preference, which is not a way past a pin', () => {
  // plan.md M8-1's third acceptance. The pin is the weakest model in the pool and it still wins.
  const pool = world([writer, tiny, strong])
  const pinned = pins({ model: 'vendor/tiny-2.6b' })
  expect(ids(route({ messages: asked('write me a personality'), capable: true }, pinned, pool))).toEqual(['vendor/tiny-2.6b'])
  expect(ids(route({ messages: asked('write me a personality'), minTier: 'T2' }, pinned, pool))).toEqual(['vendor/tiny-2.6b'])
})

test('a pin on a router is not a pin on a model, and the writer steps around it', () => {
  // `plan-personality.md` §1.2, and the bug that started the rebuild: the pin was a router,
  // so a 5,825-character description was answered by whichever free model came up — a 2.6B
  // one, which ignored the personality entirely. Somebody who pinned a router asked for
  // *surprise me*, which cannot also be an answer to *one that can write*.
  const pool = world([writer, tiny, lottery])
  const pinned = pins({ model: 'alpha-auto/free' })
  // Anything else still gets exactly what it pinned.
  expect(ids(route({ messages: asked('hello') }, pinned, pool))).toEqual(['alpha-auto/free'])
  // The writer falls through to Automatic's own order, with the router out of it.
  expect(ids(route({ messages: asked('write me a personality'), capable: true }, pinned, pool))).toEqual([
    'vendor/writer-120b',
    'vendor/tiny-2.6b',
  ])
})

// ---- never a router -------------------------------------------------------------------------

test('a router is not in the writer’s plan at all, not even last', () => {
  const pool = world([writer, tiny, lottery])
  const plain = ids(route({ messages: asked('hello') }, pins(), pool))
  // Ordinarily it is ranked last and still walked to when the models above it are busy (D159).
  expect(plain).toContain('alpha-auto/free')
  expect(plain.at(-1)).toBe('alpha-auto/free')
  // For a plugin that asked for one real model it is not a candidate: *a different model each
  // time, 2.6B included* is not a worse answer to that question, it is not an answer to it.
  expect(ids(route({ messages: asked('write me a personality'), capable: true }, pins(), pool))).toEqual([
    'vendor/writer-120b',
    'vendor/tiny-2.6b',
  ])
})

test('a list somebody made still loses its routers for the writer, and keeps its own order', () => {
  const pool = world([writer, tiny, lottery])
  const listed = pins({ order: ['alpha-auto/free', 'vendor/tiny-2.6b', 'vendor/writer-120b'] })
  expect(ids(route({ messages: asked('hello') }, listed, pool))).toEqual([
    'alpha-auto/free',
    'vendor/tiny-2.6b',
    'vendor/writer-120b',
  ])
  expect(ids(route({ messages: asked('write me a personality'), capable: true }, listed, pool))).toEqual([
    'vendor/tiny-2.6b',
    'vendor/writer-120b',
  ])
})

test('when every model that fits is a router, the writer says so rather than writing badly', () => {
  const pool = world([lottery])
  expect(ids(route({ messages: asked('write me a personality'), capable: true }, pins(), pool))).toEqual([
    'every model that fits this hands the request on to a different model each time, and this needs one model — pin one on the Models tab, or connect a provider that offers one of its own',
  ])
})

// ---- never a model Alexia doubts, while anything else fits ----------------------------------

test('a doubted or untried model waits below the writer’s plan while anything else fits', () => {
  const doubts = health({
    'alpha\nvendor/shaky-70b': judgement({ doubted: true }),
    'alpha\nvendor/fresh-70b': judgement({ untested: true }),
  })
  const pool = world([writer, shaky, fresh], { health: doubts })
  // Automatic still asks them, after the models it has no doubts about (D161).
  expect(ids(route({ messages: asked('hello') }, pins(), pool))).toEqual([
    'vendor/writer-120b',
    'vendor/shaky-70b',
    'vendor/fresh-70b',
  ])
  // The writer does not, while something else can do the work.
  expect(ids(route({ messages: asked('write me a personality'), capable: true }, pins(), pool))).toEqual(['vendor/writer-120b'])
})

test('and it asks them when nothing else can, rather than refusing a button somebody pressed', () => {
  // The difference between this and the router above, and it is deliberate. A router is not a
  // capable model on its best day; a model with three failures behind it might be the only one
  // awake at eleven at night, and a button that refuses rather than trying it is worse.
  const doubts = health({
    'alpha\nvendor/shaky-70b': judgement({ doubted: true }),
    'alpha\nvendor/fresh-70b': judgement({ untested: true }),
  })
  const pool = world([shaky, fresh], { health: doubts })
  expect(ids(route({ messages: asked('write me a personality'), capable: true }, pins(), pool))).toEqual([
    'vendor/shaky-70b',
    'vendor/fresh-70b',
  ])
})

test('set aside is skipped for the writer the way it is for everybody, and asked when it is all there is', () => {
  const put = health({ 'alpha\nvendor/tiny-2.6b': judgement({ aside: 'answers empty' }) })
  const pool = world([writer, tiny], { health: put })
  expect(ids(route({ messages: asked('write me a personality'), capable: true }, pins(), pool))).toEqual(['vendor/writer-120b'])
  const alone = world([tiny], { health: put })
  expect(ids(route({ messages: asked('write me a personality'), capable: true }, pins(), alone))).toEqual(['vendor/tiny-2.6b'])
})

// ---- what asking for a capable model does not change ----------------------------------------

test('the slider is still a filter, and the writer does not spend past free only', () => {
  const pool = world([writer, tiny, strong])
  expect(ids(route({ messages: asked('write me a personality'), capable: true }, pins({ spend: 'free' }), pool))).toEqual([
    'vendor/writer-120b',
    'vendor/tiny-2.6b',
  ])
})

test('the paid switch off pauses the writer rather than spending on its own', () => {
  // §4 H. Free first whatever the preference says, and when the free side cannot do it the
  // answer is a pause beside *Allow switching to a paid model*, not a charge.
  const pool = world([strong], { cross: false })
  const stopped = route({ messages: asked('write me a personality'), capable: true }, pins(), pool)
  expect(stopped.ok).toBe(false)
  expect(stopped.ok === false && stopped.paused).toBe('There is no free model to ask.')
})
