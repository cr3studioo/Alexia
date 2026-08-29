// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import type { Model } from '../src/catalog.js'
import { allowance, costOf, setCaps, warning } from '../src/usage.js'
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

test('tokens per model, in a window, which is what a free tier actually spends', () => {
  const store = new Store(':memory:')
  const session = store.createSession('First')
  store.recordUsage({ at: march, session, model: 'small', provider: 'p', tokensIn: 1000, tokensOut: 100, cost: 0 })
  store.recordUsage({ at: april, session, model: 'small', provider: 'p', tokensIn: 500, tokensOut: 60, cost: 0 })
  store.recordUsage({ at: april, session, model: 'big', provider: 'q', tokensIn: 40, tokensOut: 10, cost: 0 })

  // In and out together, because "how much did I put through this" is one number to the
  // person asking. Busiest first, which is the order the panel wants.
  expect(store.usedBy('model', march)).toEqual([
    { key: 'small', tokens: 1660, calls: 2 },
    { key: 'big', tokens: 50, calls: 1 },
  ])

  // The window is the whole point: on a free tier every one of these cost $0.00, so the
  // spend column cannot tell March from April and this has to.
  expect(store.usedBy('model', april)).toEqual([
    { key: 'small', tokens: 560, calls: 1 },
    { key: 'big', tokens: 50, calls: 1 },
  ])
  expect(store.usedBy('provider', april).map((row) => row.key)).toEqual(['p', 'q'])
  expect(store.usedBy('model', april + 1)).toEqual([])
  store.close()
})
