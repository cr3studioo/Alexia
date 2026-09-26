// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import type { Model } from '../src/catalog.js'
import { affordable, allowance, caps, costOf, dayStart, monthStart, setCaps, today, warning } from '../src/usage.js'
import { Store } from '../src/store.js'

// M1-9. Money, and the three questions asked of it: what did this conversation cost, what
// did this model cost, and which plugin is quietly costing me money.

const model = (id: string, priceIn: number, priceOut: number): Model => ({
  id,
  name: id,
  provider: 'openrouter',
  tier: 'T2',
  priceIn,
  priceOut,
  context: 32_768,
  supportsTools: true,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'unknown',
})

const march = Date.UTC(2026, 2, 14, 12)
const april = Date.UTC(2026, 3, 2, 12)

test('a price per million tokens, turned into money', () => {
  expect(costOf(model('m', 3, 15), { in: 1_000_000, out: 100_000 })).toBeCloseTo(4.5)
  expect(costOf(model('free', 0, 0), { in: 500_000, out: 500_000 })).toBe(0)
})

test('spend totals per session, per model and per plugin', () => {
  const store = new Store(':memory:')
  const session = store.createSession('First')
  store.recordUsage({ at: march, session, model: 'small', provider: 'p', tokensIn: 1000, tokensOut: 100, cost: 0.01 })
  store.recordUsage({ at: march, session, model: 'big', provider: 'p', tokensIn: 2000, tokensOut: 400, cost: 0.5 })
  // A plugin asking a model on its own behalf. Tagged with the plugin id since M0-2, which
  // is why this attribution costs nothing to collect.
  store.recordUsage({ at: march, plugin: 'somebody', model: 'small', provider: 'p', tokensIn: 10, tokensOut: 5, cost: 0.02 })

  expect(store.spend(march)).toBeCloseTo(0.53)
  expect(store.spend(march, { session })).toBeCloseTo(0.51)
  expect(store.spend(march, { plugin: 'somebody' })).toBeCloseTo(0.02)
  expect(store.spend(march, { model: 'small' })).toBeCloseTo(0.03)
  expect(store.spendBy('model', march)).toEqual([
    { key: 'big', cost: 0.5 },
    { key: 'small', cost: expect.closeTo(0.03) },
  ])
  expect(store.spendBy('plugin', march)).toEqual([{ key: 'somebody', cost: 0.02 }])

  // Deleting the conversation must not quietly rewrite the month's total.
  store.deleteSession(session)
  expect(store.spend(march)).toBeCloseTo(0.53)
  store.close()
})

test('the month is a month, and the cap knows where it stands in it', () => {
  const store = new Store(':memory:')
  store.recordUsage({ at: march, model: 'm', provider: 'p', tokensIn: 1, tokensOut: 1, cost: 4 })

  // No cap set is the default, and the default is no ceiling at all.
  expect(allowance(store, march)).toEqual({ spent: 4, warn: false, stop: false })

  setCaps(store, { monthly: 5 })
  const warned = allowance(store, march)
  expect(warned).toMatchObject({ spent: 4, cap: 5, warn: true, stop: false })
  expect(warning(warned)).toBe('$4.00 of your $5.00 monthly cap is spent.')

  // A warning is not a stop. The stop is a thing the user turns on deliberately.
  store.recordUsage({ at: march, model: 'm', provider: 'p', tokensIn: 1, tokensOut: 1, cost: 2 })
  expect(allowance(store, march).stop).toBe(false)
  setCaps(store, { monthly: 5, hardStop: true })
  expect(warning(allowance(store, march))).toContain('paid models are paused')

  // And April starts at nothing, because a monthly cap is monthly.
  expect(allowance(store, april)).toMatchObject({ spent: 0, warn: false, stop: false })
  store.close()
})

test('the day starts with nothing allowed, and the allowance is what changes that', () => {
  const store = new Store(':memory:')
  const noon = Date.UTC(2026, 2, 14, 12)

  // A new install. `mixed` is still the default setting, and it now behaves as free does.
  expect(today(store, noon)).toEqual({ spent: 0, allowance: 0 })
  expect(affordable(today(store, noon))).toBe(false)

  setCaps(store, { ...caps(store), daily: 1 })
  expect(affordable(today(store, noon))).toBe(true)

  // Spent to the line is spent — and the day is a day, so yesterday's is not counted
  // against today's.
  store.recordUsage({ at: noon, model: 'm', provider: 'p', tokensIn: 1, tokensOut: 1, cost: 0.4 })
  expect(today(store, noon)).toEqual({ spent: 0.4, allowance: 1 })
  expect(affordable(today(store, noon))).toBe(true)

  store.recordUsage({ at: noon, model: 'm', provider: 'p', tokensIn: 1, tokensOut: 1, cost: 0.6 })
  expect(affordable(today(store, noon))).toBe(false)

  // The next day is a fresh one. This is the reason it is daily and not monthly: an agent
  // loop can burn a month in an hour, and the free tiers it stands in for reset on this
  // clock too.
  expect(affordable(today(store, noon + 24 * 3_600_000))).toBe(true)
  store.close()
})

/**
 * Run `body` with this process on another clock, and put the old one back whatever happens.
 * Node re-reads `TZ` when it is assigned, so the `Date` arithmetic inside moves with it.
 */
function inZone(zone: string, body: () => void): void {
  const was = process.env.TZ
  process.env.TZ = zone
  try {
    body()
  } finally {
    if (was === undefined) delete process.env.TZ
    else process.env.TZ = was
  }
}

test("the day and the month are this Mac's own, not UTC's", () => {
  inZone('Europe/Prague', () => {
    // The clock really moved, or this test would be checking nothing.
    expect(new Date(Date.UTC(2026, 2, 14, 12)).getHours()).toBe(13)

    const store = new Store(':memory:')
    setCaps(store, { daily: 1 })
    // Half past eleven at night in Prague on the 13th, and half past midnight on the 14th —
    // which is still the 13th in UTC.
    store.recordUsage({ at: Date.UTC(2026, 2, 13, 22, 30), model: 'm', provider: 'p', tokensIn: 1, tokensOut: 1, cost: 0.9 })
    store.recordUsage({ at: Date.UTC(2026, 2, 13, 23, 30), model: 'm', provider: 'p', tokensIn: 1, tokensOut: 1, cost: 0.2 })

    // At one in the morning, today is the twenty cents since midnight. A UTC day would have
    // counted last night too until two, and said the allowance was already gone.
    const one = Date.UTC(2026, 2, 14, 0)
    expect(dayStart(one)).toBe(Date.UTC(2026, 2, 13, 23))
    expect(today(store, one).spent).toBeCloseTo(0.2)
    expect(affordable(today(store, one))).toBe(true)

    // The month turns at local midnight as well: 1 April 00:30 in Prague is 31 March in UTC.
    const april = Date.UTC(2026, 2, 31, 22, 30)
    expect(monthStart(april)).toBe(Date.UTC(2026, 2, 31, 22))
    expect(allowance(store, april).spent).toBe(0)
    store.close()
  })
})
