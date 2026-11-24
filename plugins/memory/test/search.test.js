// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { cosine, FLOOR, pack, rank, rankByMeaning, unpack, words } from '../search.js'

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

// Finding by meaning (P3-13). The vectors here are tiny and hand-made: what is tested is the
// ranking, not a model, so a three-number vector says exactly which way a fact points.

const vec = (...numbers) => JSON.stringify(numbers)
const meaningful = (text, daysAgo, vector) => ({ ...fact(text, daysAgo), ...(vector === undefined ? {} : { vec: vector }) })

test('meaning_beats_words', () => {
  // The fact that answers the question shares no word with it; the one that shares a word is
  // about something else. A pure keyword ranking returns only the wrong one.
  const rows = [
    meaningful('Her sister Eva lives in Brno', 30, vec(1, 0.1, 0)),
    meaningful('The sister cities programme was in the news', 2, vec(0, 0, 1)),
  ]
  expect(rank(rows, 'where does my sibling live', now)).toEqual([])
  const hits = rankByMeaning(rows, 'sister programme', vec(0.9, 0.2, 0), now)
  expect(hits[0]?.text).toMatch(/Eva lives in Brno/)
  // And a fact with no word in common at all is found by its vector alone.
  const only = rankByMeaning([rows[0]], 'where does my sibling live', vec(1, 0, 0), now)
  expect(only).toHaveLength(1)
})

test('words_still_count_without_vectors', () => {
  // Rows from before embeddings, or waiting for the backfill, have no vec and still rank on
  // their words; and with no vector for the question the result is v2's, exactly.
  const rows = [
    meaningful('The dog is called Bramble', 10),
    meaningful('Bought milk', 1),
    meaningful('Bramble had a vet appointment', 400, vec(0, 1, 0)),
  ]
  const blended = rankByMeaning(rows, 'what is the dog called', vec(0, 0, 1), now)
  expect(blended.map((row) => row.text)).toEqual(['The dog is called Bramble'])
  expect(rankByMeaning(rows, 'what is the dog called', null, now)).toEqual(rank(rows, 'what is the dog called', now))
  // Corrupt or foreign-length vectors are no vector, not an error.
  const odd = [{ ...fact('The dog is called Bramble', 5), vec: '[1,2' }, { ...fact('Dog food is in the shed', 5), vec: vec(1, 0) }]
  expect(rankByMeaning(odd, 'dog called', vec(1, 0, 0), now)[0]?.text).toBe('The dog is called Bramble')
})

test('below_threshold_dropped', () => {
  const rows = [
    meaningful('Her sister Eva lives in Brno', 30, vec(1, 0, 0)),
    // Cosine about 0.2: under the floor, and no shared word.
    meaningful('The garage door is blue', 1, vec(0.2, 0.98, 0)),
  ]
  expect(cosine([1, 0, 0], [0.2, 0.98, 0])).toBeLessThan(FLOOR)
  const hits = rankByMeaning(rows, 'sibling', vec(1, 0, 0), now)
  expect(hits.map((row) => row.text)).toEqual(['Her sister Eva lives in Brno'])
  // Nothing at all matching is nothing, not everything.
  expect(rankByMeaning(rows, 'sibling', vec(0, 0, 1), now)).toEqual([])
})

test('cosine and stored vectors are plain and forgiving', () => {
  expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10)
  expect(cosine([1, 0], [0, 1])).toBe(0)
  expect(cosine([1, 0], [-1, 0])).toBe(0)
  expect(cosine([1, 0], [1, 0, 0])).toBe(0)
  expect(cosine([0, 0], [1, 1])).toBe(0)
  expect(pack([0.123456789, 1])).toBe('[0.12346,1]')
  expect(pack([])).toBeNull()
  expect(pack([1, Number.NaN])).toBeNull()
  expect(unpack('[0.5,0.25]')).toEqual([0.5, 0.25])
  expect(unpack('nope')).toBeNull()
  expect(unpack(undefined)).toBeNull()
})

test('equal scores go to the newest', () => {
  const same = vec(1, 0, 0)
  const rows = [meaningful('older note', 100, same), meaningful('newer note', 100, same)]
  rows[1].at += 1
  expect(rankByMeaning(rows, 'zzz', same, now)[0]?.text).toBe('newer note')
})
