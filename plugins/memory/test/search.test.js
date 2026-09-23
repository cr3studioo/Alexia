// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { rank, words } from '../search.js'

// Recall is the whole product here. A memory that stores things perfectly and cannot find
// them again is a memory nobody uses, so the ranking is the part with a test.

const DAY = 24 * 60 * 60 * 1000
const now = Date.UTC(2026, 0, 1)

const fact = (text, daysAgo) => ({ text, at: now - daysAgo * DAY })

test('the words worth matching on', () => {
  // Stop words and two-letter tokens match everything and rank nothing.
  expect(words('What did I say about the car?')).toEqual(['say', 'car'])
  expect(words('')).toEqual([])
  // Deduplicated, because a question that says "car" twice does not want it twice.
  expect(words('car car CAR')).toEqual(['car'])
})

test('overlap beats recency, and recency only separates ties', () => {
  const rows = [
    fact('The dog is called Bramble and hates the vacuum cleaner', 400),
    fact('Bought milk yesterday', 1),
    fact('Bramble had a vet appointment', 30),
  ]
  const hits = rank(rows, 'what is the dog called', now)
  // Two words matched in the old row, one in the recent one. Age does not overturn that —
  // the most recent thing is rarely the most relevant, which is the whole point.
  expect(hits[0]?.text).toMatch(/Bramble and hates/)

  const tied = rank(
    [fact('Bramble is a dog', 400), fact('Bramble is a dog', 1)],
    'Bramble dog',
    now,
  )
  expect(tied[0]?.at).toBe(now - DAY)
})

test('nothing matching comes back as nothing, not as everything', () => {
  // The failure that makes a recall tool worse than useless: a question about something
  // never written down returning six unrelated rows, which the model then believes.
  const rows = [fact('The dog is called Bramble', 10), fact('Bought milk', 1)]
  expect(rank(rows, 'what is the grant deadline', now)).toEqual([])
  expect(rank(rows, '', now)).toEqual([])
  expect(rank(rows, 'the and with', now)).toEqual([])
})

test('a year-old fact is still found, because it is still true', () => {
  const rows = [fact('The grant deadline is in March', 400)]
  expect(rank(rows, 'when is the grant deadline', now)).toHaveLength(1)
})

test('Czech words survive whole, and with and without their accents', () => {
  // The old split on [a-z] turned "ČVUT" into "vut" and "Václav" into "clav".
  expect(words('Václav studuje na ČVUT')).toEqual([
    'václav',
    'vaclav',
    'studuje',
    'čvut',
    'cvut',
  ])
  // Czech stop words go the way "the" does, typed with accents or without.
  expect(words('jak jsem ale když kdyz')).toEqual([])
})

test('a question typed without accents finds the row written with them', () => {
  const rows = [fact('Václav studuje na ČVUT FEL', 30), fact('Bought milk', 1)]
  expect(rank(rows, 'kde studuje cvut', now)[0]?.text).toMatch(/ČVUT FEL/)
  expect(rank(rows, 'Vaclav', now)).toHaveLength(1)
  // One word asked is one word counted, however many spellings it has — so the accented
  // row does not outscore the plain one, and recency decides.
  const tied = rank([fact('Václav was here', 400), fact('Vaclav was here', 1)], 'Václav', now)
  expect(tied[0]?.at).toBe(now - DAY)
})

test('a bent Czech word counts half, so two of them find a row and one does not', () => {
  const rows = [fact('Niki se učí programovat s přítelkyní', 30)]
  expect(rank(rows, 'programování přítelkyně', now)).toHaveLength(1)
  // One prefix alone is too easily luck.
  expect(rank(rows, 'programování', now)).toEqual([])
  // Exact words still beat bent ones, whatever the ages.
  const both = [
    fact('Niki se učí programovat s přítelkyní', 1),
    fact('Programování a přítelkyně', 400),
  ]
  expect(rank(both, 'programování přítelkyně', now)[0]?.text).toMatch(/^Programování/)
  // Czech stop words alone ask for nothing.
  expect(rank(rows, 'jak jsem ale', now)).toEqual([])
})
