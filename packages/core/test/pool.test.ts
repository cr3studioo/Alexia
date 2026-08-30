// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { remaining, sent, spent, usable } from '../src/pool.js'
import { keyOf, PROVIDERS, type Provider } from '../src/provider.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'

// M1-6. The point of the ledger is that the router knows a tier is spent *before* it sends
// and collects a 429, so every test here is about the counting rather than the sending.

const free: Provider = { id: 'free-one', name: 'One', baseUrl: 'http://127.0.0.1:1', rpm: 2, rpd: 3 }
const other: Provider = { id: 'free-two', name: 'Two', baseUrl: 'http://127.0.0.1:2', rpm: 5, rpd: 9 }
const noon = Date.UTC(2026, 7, 27, 12, 0, 0)

const connected = async (...ids: string[]) => {
  const secrets = memorySecrets()
  for (const id of ids) await secrets.set(CORE, keyOf({ id } as Provider), 'sk-users-own-key')
  return secrets
}

test('nothing is pooled without a key the user added themselves', async () => {
  const store = new Store(':memory:')
  expect(await usable(store, memorySecrets(), [free, other], noon)).toEqual([])

  const pool = await usable(store, await connected('free-one'), [free, other], noon)
  expect(pool.map((r) => r.provider.id)).toEqual(['free-one'])
  store.close()
})

test('a tier that is spent is marked spent, and stays in the pool as itself', async () => {
  const store = new Store(':memory:')
  const secrets = await connected('free-one', 'free-two')
  const pool = async (at: number): Promise<[string, boolean][]> =>
    (await usable(store, secrets, [free, other], at)).map((r) => [r.provider.id, spent(r)])

  // Two a minute. The third request inside the same minute has nowhere free to go on this
  // one — so it is spent, and it is still a row, because what ran out is the free tier and
  // not the key. Dropping the row is what told somebody with a key that none was connected.
  sent(store, free, noon)
  sent(store, free, noon + 1_000)
  expect(remaining(store, free, noon + 2_000)).toMatchObject({ minute: 0, day: 1 })
  expect(await pool(noon + 2_000)).toEqual([
    ['free-two', false],
    ['free-one', true],
  ])

  // The next minute is a new minute.
  expect(await pool(noon + 61_000)).toEqual([
    ['free-two', false],
    ['free-one', false],
  ])

  // But the day is still counting, and three is all it has.
  sent(store, free, noon + 61_000)
  expect(remaining(store, free, noon + 62_000)).toMatchObject({ minute: 1, day: 0 })
  expect(await pool(noon + 62_000)).toEqual([
    ['free-two', false],
    ['free-one', true],
  ])
  expect(await pool(noon + 25 * 60 * 60 * 1000)).toEqual([
    ['free-two', false],
    ['free-one', false],
  ])
  store.close()
})

test('the pool spreads, rather than draining one provider and then noticing', async () => {
  const store = new Store(':memory:')
  const secrets = await connected('free-one', 'free-two')
  // `free-two` has nine a day against three, so it leads until the two have levelled.
  const first = await usable(store, secrets, [free, other], noon)
  expect(first.map((r) => r.provider.id)).toEqual(['free-two', 'free-one'])

  // Seven requests, a minute apart, so what is exhausted is the day and not the minute.
  for (let i = 0; i < 7; i++) sent(store, other, noon + i * 61_000)
  const later = await usable(store, secrets, [free, other], noon + 7 * 61_000)
  expect(later.map((r) => r.provider.id)).toEqual(['free-one', 'free-two'])
  store.close()
})

test('the ledger survives a restart, because a daily quota outlives a process', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'alexia-pool-')), 'alexia.db')
  const first = new Store(path)
  sent(first, free, noon)
  sent(first, free, noon)
  first.close()

  const restarted = new Store(path)
  expect(restarted.requests(free.id, noon)).toEqual({ minute: 2, day: 2, month: 2 })
  expect(remaining(restarted, free, noon)).toMatchObject({ minute: 0, day: 1 })
  restarted.close()
})

test('a provider only claims to know about training if somebody dated the claim', () => {
  // The flag is honest until somebody reads the terms and writes the date down. This test is
  // what keeps flipping one a deliberate act rather than a typo — and it is now a rule about
  // *provenance* rather than a rule that the answer is always unknown, because there is one
  // row where somebody did the reading and the answer is yes.
  for (const provider of PROVIDERS) {
    // Every row says when it was last checked against the provider's own docs. These
    // endpoints die monthly, and a copied table goes stale in silence.
    expect(provider.verified, provider.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // Where to check, where there is somewhere to send them.
    if (provider.terms !== undefined) expect(provider.terms, provider.id).toMatch(/^https:\/\//)
    if (provider.trainsOnYourData !== 'unknown') {
      // Known is allowed; known-and-undated is not, and neither is guessed. The one row that
      // says anything else says `yes`, which is the answer nobody would guess from a price.
      expect(provider.trainsOnYourData, provider.id).toBe('yes')
    }
  }

  // And the floor is really there: five rows that answer with nothing in the keychain. LLM7 is
  // the fifth because a live probe said so — three sources disagreed about whether it needed a
  // key, and none of them was right as written.
  const keyless = PROVIDERS.filter((p) => p.auth === 'optional' || p.auth === 'none')
  expect(keyless.map((p) => p.id)).toEqual(['ovhcloud', 'aihorde', 'uncloseai', 'kilo-gateway', 'llm7'])
})

// A free tier rationed in calls a month. `rpm` and `rpd` cannot say that: a thousand calls a
// month is not forty a day, and approximating it either strands most of the budget or
// overruns it in the first week.

const monthly: Provider = {
  id: 'by-the-call',
  name: 'By The Call',
  baseUrl: 'http://127.0.0.1:3',
  callsPerMonth: 3,
}

test('a call budget is counted in calls, and exhausting it takes the provider out of the pool', async () => {
  const store = new Store(':memory:')
  const keys = await connected('by-the-call')

  // Nothing about the size of a request touches this. A one-word question and a fifty-file
  // trace spend exactly the same amount of a call budget, which is the whole reason a token
  // number could not express it.
  expect(remaining(store, monthly, noon)).toMatchObject({ minute: Infinity, day: Infinity, month: 3 })
  sent(store, monthly, noon)
  sent(store, monthly, noon)
  expect(remaining(store, monthly, noon).month).toBe(1)
  expect(spent(remaining(store, monthly, noon))).toBe(false)
  expect((await usable(store, keys, [monthly], noon)).map((r) => r.provider.id)).toEqual(['by-the-call'])

  sent(store, monthly, noon)
  expect(remaining(store, monthly, noon).month).toBe(0)
  expect(spent(remaining(store, monthly, noon))).toBe(true)

  // Still a row — a spent tier is not a disconnected provider — and the router reads `spent`
  // to know what that costs.
  const pool = await usable(store, keys, [monthly], noon)
  expect(pool.map((r) => r.provider.id)).toEqual(['by-the-call'])
  expect(pool.every((r) => spent(r))).toBe(true)
  store.close()
})

test('the month is a calendar month, not thirty days', async () => {
  const store = new Store(':memory:')
  // Three calls in February, and March starts at three again. Thirty-day buckets would have
  // put the boundary two days into March and carried a spent budget across it.
  const feb = Date.UTC(2026, 1, 27, 12)
  for (let i = 0; i < 3; i++) sent(store, monthly, feb)
  expect(remaining(store, monthly, feb).month).toBe(0)

  const mar = Date.UTC(2026, 2, 1, 0)
  expect(remaining(store, monthly, mar).month).toBe(3)

  // A day inside the same month is the same bucket, however far apart.
  const febLater = Date.UTC(2026, 1, 28, 23)
  expect(remaining(store, monthly, febLater).month).toBe(0)
  store.close()
})
