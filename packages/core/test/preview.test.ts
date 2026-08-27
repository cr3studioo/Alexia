// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import type { Model } from '../src/catalog.js'
import { ceilings, DEFAULT_CEILINGS, estimate, previewLine, setCeilings, worthAsking } from '../src/preview.js'
import { Store } from '../src/store.js'

const model = (over: Partial<Model> = {}): Model => ({
  id: 'm',
  name: 'Some Model',
  provider: 'alpha',
  tier: 'T2',
  priceIn: 1,
  priceOut: 3,
  context: 32_768,
  supportsTools: true,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'unknown',
  ...over,
})

const asked = (text: string) => [{ role: 'user' as const, content: text }]

test('a free task is never previewed, because it is not a question', () => {
  // The long leash is the point: a confirmation in front of something that costs nothing
  // teaches people that Alexia's questions are noise.
  const free = estimate(asked('refactor the notes module'), model({ priceIn: 0, priceOut: 0, tier: 'T1' }))
  expect(free.dollars).toBe(0)
  expect(worthAsking(free, DEFAULT_CEILINGS)).toBe(false)

  // And so is a task with no model at all yet.
  expect(worthAsking(estimate(asked('hello'), undefined), DEFAULT_CEILINGS)).toBe(false)
})

test('a long task on a paid model is worth one question', () => {
  const hard = estimate(asked('refactor the notes module and explain why'), model())
  expect(hard.steps).toBe(12)
  expect(worthAsking(hard, DEFAULT_CEILINGS)).toBe(true)

  const line = previewLine(hard)
  // The model is named, because "roughly $0.04" invites "on what?".
  expect(line).toContain('about 12 steps')
  expect(line).toContain('Some Model')
  expect(line).toMatch(/\$\d+\.\d\d/)
})

test('a one-line question does not get a twelve-step estimate', () => {
  expect(estimate(asked('what time is it'), model()).steps).toBe(1)
  expect(worthAsking(estimate(asked('what time is it'), model()), DEFAULT_CEILINGS)).toBe(false)
})

test('later steps cost more than early ones, so the estimate is a sum', () => {
  // The context grows with the trace. An estimate that multiplied would undercount a long
  // task badly, and undercounting is the direction that breaks a promise.
  const one = estimate(asked('hi'), model()).dollars
  const twelve = estimate(asked('refactor this'), model()).dollars
  expect(twelve).toBeGreaterThan(one * 12)
})

test('both ceilings are editable, and the defaults are the long leash', () => {
  const store = new Store(':memory:')
  expect(ceilings(store)).toEqual(DEFAULT_CEILINGS)
  expect(ceilings(store).steps).toBe(24)

  setCeilings(store, { steps: 6, monthly: 5 })
  expect(ceilings(store)).toMatchObject({ steps: 6, monthly: 5, askAbove: DEFAULT_CEILINGS.askAbove })

  // Editing one does not silently reset the others.
  setCeilings(store, { askAbove: 0.5 })
  expect(ceilings(store)).toMatchObject({ steps: 6, monthly: 5, askAbove: 0.5 })
  store.close()
})

test('the estimate errs high, because the pleasant surprise is the safe direction', () => {
  // A preview that says four cents and charges six is a broken promise. This asserts the
  // sign of the error, not its size: the numbers are meant to be edited when they are wrong.
  const twelve = estimate(asked('debug this properly'), model({ priceIn: 1, priceOut: 1 }))
  const naive = (12 * 900) / 1_000_000 + (12 * 250) / 1_000_000
  expect(twelve.dollars).toBeGreaterThan(naive)
})
