// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import type { Model } from '../src/catalog.js'
import { judge, type Health } from '../src/health.js'
import { remaining } from '../src/pool.js'
import type { Provider } from '../src/provider.js'
import { MODES, ranking, route, type Choice, type Pins, type World } from '../src/router.js'
import { Store, type Outcome, type Seen, type Try } from '../src/store.js'

/**
 * **The model record and the tags** (`model_plan.md` §4 B, D161): what Alexia thinks of each
 * model, and what the router does about it. The numbers are the plan's acceptance, written down.
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
/** Midnight UTC on 14 September 2026, and a time on that day. */
const base = Date.UTC(2026, 8, 14)
const at = (hours: number, minutes = 0): number => base + hours * HOUR + minutes * 60_000

const alpha: Provider = { id: 'alpha', name: 'Alpha', baseUrl: 'http://127.0.0.1:1', rpm: 1000, rpd: 1000 }
/** A keyless provider, the kind that can want a key for some of its models. */
const floor: Provider = { id: 'floor', name: 'Floor', baseUrl: 'http://127.0.0.1:2', auth: 'optional', rpm: 1000, rpd: 1000 }
const openrouter: Provider = { id: 'openrouter', name: 'OpenRouter', baseUrl: 'http://127.0.0.1:3' }

const hands = (id: string, over: Partial<Model> = {}): Model => ({
  id,
  name: id,
  provider: 'alpha',
  tier: 'T1',
  priceIn: 0,
  priceOut: 0,
  context: 32_768,
  supportsTools: true,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'unknown',
  ...over,
})

const ledger = new Store(':memory:')
const world = (over: Partial<World> = {}): World => ({
  models: [],
  local: [],
  rungs: [remaining(ledger, alpha), remaining(ledger, floor), remaining(ledger, openrouter)],
  today: { spent: 0, allowance: 1 },
  ...over,
})
const pins = (over: Partial<Pins> = {}): Pins => ({ placement: MODES.combined, ...over })
const work = { messages: [{ role: 'user' as const, content: 'sort my downloads' }], tools: [{ name: 'fs.list' }] }
const where = (verdict: ReturnType<typeof route>): string[] =>
  verdict.ok ? verdict.choices.map((c) => `${c.model.id}@${c.provider.id}`) : [verdict.why]
const ids = (verdict: ReturnType<typeof route>): string[] => (verdict.ok ? verdict.choices.map((c) => c.model.id) : [verdict.why])

const tried = (model: string, outcome: Outcome, when: number, provider = 'alpha'): Try => ({
  at: when,
  provider,
  model,
  outcome,
  status: outcome === 'answered' ? 200 : outcome === 'busy' ? 429 : outcome === 'retired' ? 404 : 502,
  source: 'chat',
})
const of = (health: Health, model: string, provider = 'alpha') => health.get(`${provider}\n${model}`)
const says = (health: Health, model: string, provider = 'alpha'): string[] =>
  (of(health, model, provider)?.tags ?? []).map((tag) => tag.says)

// ---- Busy is not broken, but a whole day of nothing else is ----------------------------------

const busy = hands('free/busy', { weekly: 9_000 })
const other = hands('free/other', { weekly: 1 })
const pair = [busy, other]

test('three refusals spread over a day set a model aside; three in ten minutes only make it busy', () => {
  const day = [tried('free/busy', 'busy', at(10)), tried('free/busy', 'busy', at(11)), tried('free/busy', 'busy', at(12, 30))]
  const walled = judge(day, [], pair, new Set(), at(13))
  expect(of(walled, 'free/busy')?.aside).toBe('always busy for you')
  expect(says(walled, 'free/busy')).toEqual(['always busy for you'])
  // Out of Automatic's plan, though it is the busier model.
  expect(ids(route(work, pins(), world({ models: pair, health: walled })))).toEqual(['free/other'])

  const rush = [tried('free/busy', 'busy', at(20)), tried('free/busy', 'busy', at(20, 5)), tried('free/busy', 'busy', at(20, 10))]
  const evening = judge(rush, [], pair, new Set(), at(20, 15))
  expect(of(evening, 'free/busy')?.aside).toBeUndefined()
  expect(says(evening, 'free/busy')).toEqual(['busy'])
  expect(ids(route(work, pins(), world({ models: pair, health: evening })))).toEqual(['free/busy', 'free/other'])
  // And busy clears by itself after the hour.
  expect(says(judge(rush, [], pair, new Set(), at(21, 30)), 'free/busy')).toEqual([])
})

test('set aside lasts until one good reply, not until the day ages out', () => {
  const day = [tried('free/busy', 'busy', at(10)), tried('free/busy', 'busy', at(11)), tried('free/busy', 'busy', at(12, 30))]
  // The next morning, with nothing new: still aside. The mock-up's *a test message tomorrow;
  // one good reply brings it back* (D161), and the reason §4 E exists.
  expect(of(judge(day, [], pair, new Set(), at(34)), 'free/busy')?.aside).toBe('always busy for you')
  // One good reply the next day: back, and first again.
  const back = judge([...day, tried('free/busy', 'answered', at(33))], [], pair, new Set(), at(34))
  expect(of(back, 'free/busy')?.aside).toBeUndefined()
  expect(ids(route(work, pins(), world({ models: pair, health: back })))).toEqual(['free/busy', 'free/other'])
  // And a month later the record itself has let go.
  expect(of(judge(day, [], pair, new Set(), at(12, 30) + 31 * DAY), 'free/busy')?.aside).toBeUndefined()
})

test('the same wall of timeouts and errors is not answering; a Mac that could not connect is neither (D162)', () => {
  const mixed = [tried('free/busy', 'slow', at(10)), tried('free/busy', 'busy', at(11)), tried('free/busy', 'failed', at(12, 30))]
  expect(of(judge(mixed, [], pair, new Set(), at(13)), 'free/busy')?.aside).toBe('not answering')

  // An evening without a network: every model Automatic walked could not be reached. That sinks
  // them for the hour (the store's strikes) and sets none of them aside.
  const offline = [at(10), at(11), at(12, 30)].map((when) => tried('free/busy', 'unreachable', when))
  expect(of(judge(offline, [], pair, new Set(), at(13)), 'free/busy')?.aside).toBeUndefined()
})

// ---- Empty, retired, and wanting a key ---------------------------------------------------------

test('three empty answers in a row set a model aside; a good reply between starts the count again', () => {
  const models = [hands('free/classifier')]
  const empties = [1, 2, 3].map((hour) => tried('free/classifier', 'empty', at(hour)))
  expect(of(judge(empties, [], models, new Set(), at(4)), 'free/classifier')?.aside).toBe('answers empty')

  const broken = [empties[0]!, empties[1]!, tried('free/classifier', 'answered', at(2, 30)), empties[2]!]
  expect(of(judge(broken, [], models, new Set(), at(4)), 'free/classifier')?.aside).toBeUndefined()
})

test('no longer offered twice in a row is retired; with an answer between it is not', () => {
  const models = [hands('free/old')]
  const gone = (outcomes: Outcome[]): Health =>
    judge(
      outcomes.map((outcome, i) => tried('free/old', outcome, at(i + 1))),
      [],
      models,
      new Set(),
      at(10),
    )
  expect(of(gone(['retired', 'answered', 'retired']), 'free/old')?.aside).toBeUndefined()
  expect(of(gone(['retired', 'retired']), 'free/old')?.aside).toBe('retired')

  // Gone from its provider's list, or past the date the provider published: retired too.
  const left: Seen[] = [{ provider: 'alpha', model: 'free/old', firstSeen: at(0) - 60 * DAY, listKnown: true, goneAt: at(5) }]
  expect(of(judge([], left, models, new Set(), at(10)), 'free/old')?.aside).toBe('retired')
  const expired = [hands('free/old', { expires: at(5) })]
  expect(of(judge([], [], expired, new Set(), at(10)), 'free/old')?.aside).toBe('retired')
  // And a date inside 30 days is said before it happens, and changes nothing.
  const soon = judge([], [], [hands('free/old', { expires: Date.UTC(2026, 8, 30) })], new Set(), at(10))
  expect(says(soon, 'free/old')).toEqual(['retiring 30 Sep'])
  expect(of(soon, 'free/old')?.aside).toBeUndefined()
})

test('a keyless provider refusing two of its models sets every model of it aside, until a key is saved', () => {
  const models = ['floor/a', 'floor/b', 'floor/c'].map((id) => hands(id, { provider: 'floor' }))
  const refusals = [tried('floor/a', 'needs-key', at(1), 'floor'), tried('floor/b', 'needs-key', at(2), 'floor')]

  const stranger = judge(refusals, [], models, new Set(), at(3))
  expect(['floor/a', 'floor/b', 'floor/c'].map((id) => of(stranger, id, 'floor')?.aside)).toEqual([
    'needs a key',
    'needs a key',
    'needs a key',
  ])
  // Saving a key is enough: the next world judges with it, and nothing waits for a restart.
  const keyed = judge(refusals, [], models, new Set(['floor']), at(3))
  expect(['floor/a', 'floor/b', 'floor/c'].map((id) => of(keyed, id, 'floor')?.aside)).toEqual([undefined, undefined, undefined])

  // One model refused once is that model's business, and not yet a reason.
  expect(of(judge(refusals.slice(0, 1), [], models, new Set(), at(3)), 'floor/a', 'floor')?.aside).toBeUndefined()
  // Refused twice, it is — and its neighbours still answer.
  const twice = judge([refusals[0]!, tried('floor/a', 'needs-key', at(2), 'floor')], [], models, new Set(), at(3))
  expect(of(twice, 'floor/a', 'floor')?.aside).toBe('needs a key')
  expect(of(twice, 'floor/b', 'floor')?.aside).toBeUndefined()
  // A model of that provider that has answered since the refusals is back by its own reply.
  const answeredSince = judge([...refusals, tried('floor/c', 'answered', at(2, 30), 'floor')], [], models, new Set(), at(3))
  expect(of(answeredSince, 'floor/c', 'floor')?.aside).toBeUndefined()
})

// ---- Set aside is never deleted: lists, pins, and a plan with nothing else ------------------

test('a list skips a set-aside entry, asks them all when every entry is set aside, and a pin is asked anyway', () => {
  const one = hands('free/one')
  const two = hands('free/two')
  const models = [one, two]
  const day = (model: string): Try[] => [at(10), at(11), at(12, 30)].map((when) => tried(model, 'busy', when))

  const firstAside = judge(day('free/one'), [], models, new Set(), at(13))
  expect(ids(route(work, pins({ order: ['free/one', 'free/two'] }), world({ models, health: firstAside })))).toEqual(['free/two'])

  const bothAside = judge([...day('free/one'), ...day('free/two')], [], models, new Set(), at(13))
  const list = route(work, pins({ order: ['free/one', 'free/two'] }), world({ models, health: bothAside }))
  expect(list.mode).toBe('sequence')
  expect(ids(list)).toEqual(['free/one', 'free/two'])
  // Automatic with nothing else in it asks them too: a refusal collected beats one guessed.
  expect(ids(route(work, pins(), world({ models, health: bothAside })))).toEqual(['free/one', 'free/two'])

  expect(ids(route(work, pins({ model: 'free/one' }), world({ models, health: firstAside })))).toEqual(['free/one'])
})

test('a pin on a model served twice goes to the copy that is not set aside, and is still one choice', () => {
  const models = [hands('same/model', { provider: 'openrouter' }), hands('same/model', { provider: 'floor' })]
  const day = [at(10), at(11), at(12, 30)].map((when) => tried('same/model', 'busy', when, 'openrouter'))
  const health = judge(day, [], models, new Set(['openrouter']), at(13))
  expect(where(route(work, pins({ model: 'same/model' }), world({ models, health })))).toEqual(['same/model@floor'])
})

test('what only a set-aside model can take still reaches it', () => {
  const eyes = hands('free/eyes', { modality: ['text', 'image'] })
  const blind = hands('free/blind')
  const models = [eyes, blind]
  const day = [at(10), at(11), at(12, 30)].map((when) => tried('free/eyes', 'busy', when))
  const health = judge(day, [], models, new Set(), at(13))
  const picture = { ...work, modality: ['image'] }
  expect(ids(route(picture, pins(), world({ models, health })))).toEqual(['free/eyes'])
})

// ---- New, and doubted -----------------------------------------------------------------------

test('a new model starts at the bottom, its first good reply puts it at its size’s middle, and its own figure then places it', () => {
  const now = at(12)
  const fresh = hands('vendor/fresh-70b')
  const sized = [900, 500, 100, 10].map((weekly, i) => hands(`vendor/known-${String(i)}-70b`, { weekly }))
  const models = [fresh, ...sized]
  // Seen for the first time two days ago, on a provider whose list this Mac already knew.
  const seen: Seen[] = [{ provider: 'alpha', model: 'vendor/fresh-70b', firstSeen: now - 2 * DAY, listKnown: true }]

  const untried = judge([], seen, models, new Set(), now)
  expect(of(untried, 'vendor/fresh-70b')).toMatchObject({ untested: true })
  expect(says(untried, 'vendor/fresh-70b')).toEqual(['new · not tried yet'])
  expect(ids(route(work, pins(), world({ models, health: untried }))).at(-1)).toBe('vendor/fresh-70b')

  // One good reply, from a test or a real question: the middle of models its size, which is 300.
  const answered = judge([tried('vendor/fresh-70b', 'answered', now - HOUR)], seen, models, new Set(), now)
  expect(of(answered, 'vendor/fresh-70b')).toMatchObject({ untested: false, standIn: 300 })
  expect(ids(route(work, pins(), world({ models, health: answered })))).toEqual([
    'vendor/known-0-70b',
    'vendor/known-1-70b',
    'vendor/fresh-70b',
    'vendor/known-2-70b',
    'vendor/known-3-70b',
  ])

  // Then OpenRouter's figure arrives, and it is placed by that, down as readily as up.
  const figured = [hands('vendor/fresh-70b', { weekly: 5 }), ...sized]
  const placed = judge([tried('vendor/fresh-70b', 'answered', now - HOUR)], seen, figured, new Set(), now)
  expect(ids(route(work, pins(), world({ models: figured, health: placed }))).at(-1)).toBe('vendor/fresh-70b')

  // After 14 days without a figure it ranks like any model without one. First seen two days
  // before `now`, so eleven days on it is still new and thirteen days on it is not.
  const replied = [tried('vendor/fresh-70b', 'answered', now - HOUR)]
  expect(of(judge(replied, seen, models, new Set(), now + 11 * DAY), 'vendor/fresh-70b')?.standIn).toBe(300)
  expect(of(judge(replied, seen, models, new Set(), now + 13 * DAY), 'vendor/fresh-70b')?.standIn).toBeUndefined()
  expect(of(judge([], seen, models, new Set(), now + 13 * DAY), 'vendor/fresh-70b')).toMatchObject({ untested: false })
})

test('on a fresh install everything is first seen at once, so only a recent created date makes a model new', () => {
  const now = at(12)
  const models = [hands('vendor/old'), hands('vendor/added', { created: now - 3 * DAY })]
  const firstRun: Seen[] = models.map((model) => ({ provider: 'alpha', model: model.id, firstSeen: now - HOUR, listKnown: false }))
  const health = judge([], firstRun, models, new Set(), now)
  expect(of(health, 'vendor/old')?.untested).toBe(false)
  expect(of(health, 'vendor/added')?.untested).toBe(true)
})

test('too many errors or two bad answers move a model below every model without doubts, and busy is not an error', () => {
  const shaky = hands('free/shaky', { weekly: 9_000 })
  const steady = hands('free/steady', { weekly: 1 })
  const models = [shaky, steady]
  const outcomes: Outcome[] = ['answered', 'failed', 'answered', 'slow', 'empty']
  const errors = judge(
    outcomes.map((outcome, i) => tried('free/shaky', outcome, at(i + 1))),
    [],
    models,
    new Set(),
    at(10),
  )
  expect(says(errors, 'free/shaky')).toEqual(['too many errors'])
  expect(of(errors, 'free/shaky')?.aside).toBeUndefined()
  expect(ids(route(work, pins(), world({ models, health: errors })))).toEqual(['free/steady', 'free/shaky'])

  // Ten rate limits and one answer: an evening, not a doubt.
  const evening = judge(
    [...Array.from({ length: 10 }, (_, i) => tried('free/shaky', 'busy', at(1, i))), tried('free/shaky', 'answered', at(2))],
    [],
    models,
    new Set(),
    at(10),
  )
  expect(of(evening, 'free/shaky')?.doubted).toBe(false)

  const pressed = judge(
    [tried('free/shaky', 'bad-answer', at(1)), tried('free/shaky', 'bad-answer', at(5))],
    [],
    models,
    new Set(),
    at(10),
  )
  expect(says(pressed, 'free/shaky')).toEqual(['gave bad answers'])
  expect(ids(route(work, pins(), world({ models, health: pressed })))).toEqual(['free/steady', 'free/shaky'])
})

test('the facts are tags too, and do nothing the ranking did not already do', () => {
  const models = [
    hands('kilo-auto/free', { name: 'Auto Free' }),
    hands('liquid/lfm-2.5-2.6b:free'),
    hands('vendor/talker', { supportsTools: false, trainsOnYourData: 'yes' }),
  ]
  const health = judge([], [], models, new Set(), at(1))
  expect(says(health, 'kilo-auto/free')).toEqual(['router'])
  expect(says(health, 'liquid/lfm-2.5-2.6b:free')).toEqual(['under 7B'])
  expect(says(health, 'vendor/talker')).toEqual(['talk only', 'keeps your words'])
})

// ---- The order does not move on the same failures (D159) ------------------------------------

test('D159’s order holds over failures read from the record', () => {
  const record = new Store(':memory:')
  const best = hands('free/best', { weekly: 9_000_000 })
  const next = hands('free/next', { weekly: 10 })
  const struckAt = (...minutesAgo: number[]): World => {
    const fresh = new Store(':memory:')
    for (const ago of minutesAgo) {
      fresh.recordTry({ provider: 'alpha', model: 'free/best', outcome: 'busy', status: 429, source: 'chat', at: Date.now() - ago * 60_000 })
    }
    // A refused key and an answer are in the record and are not strikes.
    fresh.recordTry({ provider: 'alpha', model: 'free/best', outcome: 'key-refused', status: 401, source: 'chat' })
    fresh.recordTry({ provider: 'alpha', model: 'free/next', outcome: 'answered', status: 200, source: 'chat' })
    return world({ models: [best, next], strikes: fresh.strikes() })
  }
  expect(ids(route(work, pins(), struckAt()))).toEqual(['free/best', 'free/next'])
  expect(ids(route(work, pins(), struckAt(50, 10)))).toEqual(['free/next', 'free/best'])
  expect(ids(route(work, pins(), struckAt(70)))).toEqual(['free/best', 'free/next'])
  expect(ids(route(work, pins(), struckAt(70, 70)))).toEqual(['free/next', 'free/best'])
  record.close()
})

// ---- The why-line is the ranking ------------------------------------------------------------

test('each row’s why-line names the key that put it below the row above', () => {
  const choice = (model: Model, provider: Provider = alpha, keyed?: boolean): Choice => ({
    model,
    provider,
    ...(keyed !== undefined && { keyed }),
  })
  const gemma = hands('google/gemma-4-31b-it:free', { name: 'Google: Gemma 4 31B', weekly: 391_965_209_752 })
  const smaller = hands('google/gemma-4-26b-a4b-it:free', { name: 'Google: Gemma 4 26B A4B', weekly: 317_139_519_783 })
  const lent = hands('nvidia/nemotron-3-super-120b-a12b:free', {
    name: 'NVIDIA: Nemotron 3 Super',
    provider: 'floor',
    weekly: 10_043_068_411,
    weeklyFrom: 'openrouter',
  })
  const router = hands('kilo-auto/free', { name: 'Auto Free' })
  const talker = hands('vendor/talker', { name: 'Talker', supportsTools: false })
  const unsized = hands('poolside/laguna-s-2.1:free', { name: 'Laguna S 2.1', weekly: 69_326_928_584 })
  const tiny = hands('liquid/lfm-2.5-2.6b:free', { name: 'LFM2.5-2.6B', weekly: 2_056_029 })
  const unpublished = hands('vendor/quiet-70b', { name: 'Quiet 70B' })
  // Paid models that read more than the free ones, so they are worth buying and are in the plan.
  const priced = hands('paid/small', { name: 'Small', tier: 'T2', priceIn: 0.05, context: 128_000 })
  const dearer = hands('paid/dearer', { name: 'Dearer', tier: 'T2', priceIn: 0.2, context: 128_000 })
  const fresh = hands('vendor/fresh-70b', { name: 'Fresh' })

  const health = judge([], [{ provider: 'alpha', model: 'vendor/fresh-70b', firstSeen: Date.now() - DAY, listKnown: true }], [fresh], new Set(), Date.now())
  const ranked = ranking({
    strikes: [{ provider: 'alpha', model: smaller.id, at: Date.now() - 60_000, outcome: 'busy' }],
    health,
  })
  const plain = ranking({})

  expect(plain.explain(choice(smaller), choice(gemma))).toBe(
    'The world sent it 317B tokens last week, fewer than Google: Gemma 4 31B’s 392B.',
  )
  expect(plain.explain(choice(lent, floor, true), choice(smaller))).toBe(
    'The world sent it 10B tokens last week (figure from OpenRouter), fewer than Google: Gemma 4 26B A4B’s 317B.',
  )
  expect(plain.explain(choice(lent, floor), choice(gemma, openrouter, true))).toBe(
    'No key needed, so shared and rationed for everyone. After models on your key.',
  )
  expect(plain.explain(choice(router), choice(tiny))).toBe(
    'A router: a different free model each time, some of them tiny. Asked after every single model.',
  )
  expect(plain.explain(choice(talker), choice(router))).toBe('Can only talk, not use tools, so it comes after every model that can.')
  expect(plain.explain(choice(unsized), choice(gemma))).toBe('Its size isn’t published, so it comes after models known to be 7B or more.')
  expect(plain.explain(choice(tiny), choice(unsized))).toBe(
    'Under 7B (read from its name), so it comes after every model not known to be that small.',
  )
  expect(plain.explain(choice(unpublished), choice(gemma))).toBe(
    'Nobody publishes how much it is used, so it comes after the models that have a figure.',
  )
  expect(plain.explain(choice(priced), choice(talker))).toBe('Costs money, so it comes after every free model.')
  expect(plain.explain(choice(dearer), choice(priced))).toBe('Costs $0.20 per million tokens in, more than Small’s $0.05.')
  expect(ranked.explain(choice(smaller), choice(gemma))).toBe(
    'Was busy recently, so it sits below Google: Gemma 4 31B for about an hour.',
  )
  expect(ranked.explain(choice(fresh), choice(tiny))).toBe(
    'New and not tried yet, so it waits below every model that has answered. One good reply moves it up.',
  )
  expect(plain.explain(choice(unpublished), choice(hands('vendor/quiet-70b', { name: 'Twin' })))).toBe(
    'Ties with Twin on everything Alexia knows; the provider’s own order decides.',
  )
  // Handed over the wrong way round, it still says why the lower one is lower.
  expect(plain.explain(choice(gemma), choice(smaller))).toBe(plain.explain(choice(smaller), choice(gemma)))
  expect(plain.decides(choice(smaller), choice(gemma))).toBe('usage')
  expect(plain.decides(choice(gemma), choice(smaller))).toBeUndefined()
  // `/best` turns only the money round, and says so.
  expect(ranking({}, 'best').explain(choice(priced), choice(dearer))).toBe('/best turns the money order round, so it comes after Dearer.')

  // And over a real plan, every row is below the one above on some key or ties with it: the
  // comparator and the sentence are one list, so the table cannot say a different order.
  const models = [router, talker, tiny, unsized, gemma, smaller, unpublished, priced, dearer]
  const plan = route({ messages: work.messages }, pins(), world({ models }))
  expect(plan.ok).toBe(true)
  const choices = plan.ok ? plan.choices : []
  for (const [i, lower] of choices.entries()) {
    if (i === 0) continue
    expect(plain.compare(lower, choices[i - 1]!)).toBeGreaterThanOrEqual(0)
  }
  expect(choices.map((one) => one.model.id)).toEqual([
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'vendor/quiet-70b',
    'poolside/laguna-s-2.1:free',
    'liquid/lfm-2.5-2.6b:free',
    'kilo-auto/free',
    'vendor/talker',
    'paid/small',
    'paid/dearer',
  ])
  expect(choices.slice(1).map((lower, i) => plain.decides(lower, choices[i]!))).toEqual([
    'usage',
    'usage',
    'size',
    'size',
    'router',
    'tools',
    'group',
    'price',
  ])
})
