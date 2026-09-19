// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, test } from 'vitest'
import type { Model } from '../src/catalog.js'
import { judge } from '../src/health.js'
import { remaining } from '../src/pool.js'
import { keyOf, type Provider } from '../src/provider.js'
import type { World } from '../src/router.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'
import { due, TEST_MESSAGE, TESTS_A_DAY, trial } from '../src/trial.js'

/**
 * `model_plan.md` §4 E's acceptance: **with 14 models due, 10 tests go out, none to a paid model,
 * none while an answer streams, and nothing lands in a conversation or the spend ledger.**
 */

/** Every request the provider received: which model, and exactly what it was sent. */
const received: { model: string; messages: unknown }[] = []
const server: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const body = JSON.parse(raw) as { model: string; messages: unknown }
    received.push({ model: body.model, messages: body.messages })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
afterAll(() => void server.close())

const stub: Provider = { id: 'stub', name: 'Stub', baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`, rpm: 1000, rpd: 1000 }
const floor: Provider = { ...stub, id: 'floor', name: 'Floor', auth: 'optional' }
const secrets = memorySecrets()
await secrets.set(CORE, keyOf(stub), 'sk-stub')

const model = (id: string, over: Partial<Model> = {}): Model => ({
  id,
  name: id,
  provider: 'stub',
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

const HOUR = 60 * 60 * 1000
// Noon UTC of whatever day this runs, not a fixed date. This test travels a day forward, and
// `send()` stamps a try with the real clock rather than the `now` it was handed — so once the
// real clock passed a hardcoded `now + 24h`, the ten tests sent on day one read as never sent
// and the cap went out again instead of the remaining four. It ran green for a year and then
// failed on 2026-09-18 having changed nothing. Noon keeps a day's budget off a UTC midnight.
const midday = new Date()
const now = Date.UTC(midday.getUTCFullYear(), midday.getUTCMonth(), midday.getUTCDate(), 12)

/** Twelve new models, two free ones set aside, two paid ones set aside, one wanting a key with none saved, and one that is fine. */
function setting(): { store: Store; world: (at?: number) => World } {
  const store = new Store(':memory:')
  const fresh = Array.from({ length: 12 }, (_, i) => model(`new/${String(i).padStart(2, '0')}`))
  const aside = [model('aside/empty'), model('aside/busy')]
  const paidAside = [model('paid/one', { tier: 'T2', priceIn: 1 }), model('paid/two', { tier: 'T3', priceIn: 5 })]
  const keyless = model('floor/wants-key', { provider: 'floor' })
  const fine = model('fine/one')
  const models = [...fresh, ...aside, ...paidAside, keyless, fine]

  const tried = (id: string, provider: string, outcome: 'empty' | 'busy' | 'needs-key' | 'answered', at: number): void =>
    store.recordTry({ provider, model: id, outcome, status: outcome === 'answered' ? 200 : 429, source: 'chat', at })
  for (const one of fresh) {
    store.recordSeen('stub', { added: [one.id], removed: [], listKnown: true }, now - 2 * HOUR)
  }
  for (const at of [1, 2, 3]) tried('aside/empty', 'stub', 'empty', now - (10 - at) * HOUR)
  for (const at of [0, 60, 150]) tried('aside/busy', 'stub', 'busy', now - 5 * HOUR + at * 60_000)
  for (const one of paidAside) for (const at of [1, 2, 3]) tried(one.id, 'stub', 'empty', now - (10 - at) * HOUR)
  tried('floor/wants-key', 'floor', 'needs-key', now - 3 * HOUR)
  tried('floor/wants-key', 'floor', 'needs-key', now - 2 * HOUR)
  tried('fine/one', 'stub', 'answered', now - HOUR)

  const world = (at: number = now): World => {
    const rungs = [{ ...remaining(store, stub, at), keyed: true }, { ...remaining(store, floor, at), keyed: false }]
    return {
      models,
      local: [],
      rungs,
      today: { spent: 0, allowance: 0 },
      health: judge(store.tries(at), store.seen(), models, new Set(['stub']), at),
    }
  }
  return { store, world }
}

test('fourteen due, ten go out: free only, the one fixed sentence, recorded as tests, and not in the ledger', async () => {
  const { store, world } = setting()
  const wanted = due(world(), store.tries(now)).map((one) => one.model.id)
  // Twelve new and two set aside: not the paid ones, not the model wanting a key nobody saved, not the fine one.
  expect(wanted).toHaveLength(14)
  expect(wanted.filter((id) => id.startsWith('paid/') || id === 'floor/wants-key' || id === 'fine/one')).toEqual([])

  received.length = 0
  expect(await trial({ world: world(), store, secrets, busy: () => false, now })).toBe(TESTS_A_DAY)
  expect(received).toHaveLength(10)
  expect(received.every((one) => !one.model.startsWith('paid/'))).toBe(true)
  expect(received.every((one) => JSON.stringify(one.messages) === JSON.stringify([{ role: 'user', content: TEST_MESSAGE }]))).toBe(true)
  // The oldest evidence first, and a model never asked has the oldest there is: the new ones.
  expect(received.every((one) => one.model.startsWith('new/'))).toBe(true)

  const tests = store.tries(Date.now()).filter((one) => one.source === 'test')
  expect(tests).toHaveLength(10)
  expect(tests.every((one) => one.outcome === 'answered')).toBe(true)
  // Nothing in a conversation, and nothing in the spend ledger.
  expect(store.sessions()).toEqual([])
  expect(store.spendBy('model', 0)).toEqual([])

  // A new model that answered a test is not new any more.
  //
  // **Read at the fixture's own clock, not the wall's.** A try is stamped by whichever clock
  // the caller reasons in, so a test that travels a day forward and then reads the record at
  // `Date.now()` is asking about a different day than the one it just wrote into.
  const answered = judge(store.tries(now), store.seen(), world().models, new Set(['stub']), now)
  expect(answered.get('stub\nnew/00')?.untested).toBe(false)

  // The day's ten are spent, and a second round the same day sends nothing — a restart included,
  // since the store remembers. The next day, the four still due go.
  received.length = 0
  expect(await trial({ world: world(), store, secrets, busy: () => false, now: now + HOUR })).toBe(0)
  expect(received).toEqual([])
  received.length = 0
  expect(await trial({ world: world(now + 24 * HOUR), store, secrets, busy: () => false, now: now + 24 * HOUR })).toBe(4)
  expect(received.map((one) => one.model).sort()).toEqual(['aside/busy', 'aside/empty', 'new/10', 'new/11'])
  // And one good reply brings a set-aside model back — asked the day the reply was given.
  const tomorrow = now + 24 * HOUR
  const back = judge(store.tries(tomorrow), store.seen(), world().models, new Set(['stub']), tomorrow)
  expect([back.get('stub\naside/empty')?.aside, back.get('stub\naside/busy')?.aside]).toEqual([undefined, undefined])
  store.close()
})

test('a try is stamped by the clock its caller reasons in, not by the wall', async () => {
  /**
   * **The seam `trial.test.ts` was hiding, closed.** `send()` wrote every try with
   * `Date.now()` no matter what the caller thought the time was, so this file's own day-travel
   * wrote tries into *today* and then read them back as *tomorrow's* — which is why the ten
   * day-one assertions started failing on a date nobody changed anything on (2026-09-18), a
   * year after they were written.
   *
   * It is not a test-only seam. A record whose rows are timestamped by one clock and queried
   * by another is a record that disagrees with itself about where a day ends, and `judge()`
   * reasons in days: a whole day of refusals sets a model aside, and the daily test's
   * allowance is per day.
   */
  const { store, world } = setting()
  received.length = 0
  const later = now + 24 * HOUR
  expect(await trial({ world: world(later), store, secrets, busy: () => false, now: later })).toBe(TESTS_A_DAY)

  // Every try that round made carries the caller's clock, to the minute, and none carries the
  // wall's — which on this machine is a different day from the fixture's whenever it matters.
  const written = store.tries(later).filter((one) => one.source === 'test' && one.at >= now)
  expect(written.length).toBeGreaterThan(0)
  expect(written.every((one) => Math.abs(one.at - later) < 60_000)).toBe(true)
  // And `judge()` — which is the reader that reasons in days — sees none of them a day
  // earlier, which is the whole property: a day boundary means the same thing to the writer
  // and to the reader. (`store.tries(at)` is a 30-day window with no upper bound; `judge()` is
  // where the *at or before* half lives.)
  const earlier = judge(store.tries(now), store.seen(), world(now).models, new Set(['stub']), now)
  expect(earlier.get('stub\nnew/00')?.untested).toBe(true)
  store.close()
})

test('an answer that starts streaming stops the round, and none goes out while one is', async () => {
  const { store, world } = setting()
  received.length = 0
  expect(await trial({ world: world(), store, secrets, busy: () => true, now })).toBe(0)
  expect(received).toEqual([])

  // Somebody starts typing after the second test.
  let asked = 0
  expect(await trial({ world: world(), store, secrets, busy: () => asked++ >= 2, now })).toBe(2)
  expect(received).toHaveLength(2)
  store.close()
})
