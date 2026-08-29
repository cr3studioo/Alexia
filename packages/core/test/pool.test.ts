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
  expect(restarted.requests(free.id, noon)).toEqual({ minute: 2, day: 2 })
  expect(remaining(restarted, free, noon)).toMatchObject({ minute: 0, day: 1 })
  restarted.close()
})

test('every seeded provider says unknown about training, and says where to check', () => {
  // The flag is honest until somebody reads the terms and writes the date down. This test
  // is what makes flipping one a deliberate act rather than a typo.
  for (const provider of PROVIDERS) {
    expect(provider.terms, provider.id).toMatch(/^https:\/\//)
    expect(provider.trainsOnYourData, provider.id).toBe('unknown')
  }
})
