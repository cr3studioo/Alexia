// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { MOST, score, search, type Searchable } from '../src/palette.js'

/**
 * The palette's ranking (M6-10).
 *
 * Fifteen lines and no dependency, because this is ranking four short in-memory lists rather
 * than tuning relevance. What is worth holding still is the **shape of the ladder** — exact,
 * then starts-with, then substring, then subsequence — because that shape is what makes
 * typing three letters land on the thing you meant.
 */

test('the ladder, in order', () => {
  expect(score('voice', 'voice')).toBeGreaterThan(score('voice', 'voice notes'))
  expect(score('voice', 'voice notes')).toBeGreaterThan(score('voice', 'the voice panel'))
  expect(score('vce', 'voice')).toBeGreaterThan(0)
  expect(score('vce', 'voice')).toBeLessThan(score('voice', 'the voice panel'))
  // Not a match at all, however generous the ladder gets.
  expect(score('zebra', 'voice')).toBe(0)
  expect(score('', 'voice')).toBe(0)
})

test('a shorter thing that starts with what you typed beats a longer one', () => {
  // Typing "sk" should land on *skills* rather than on *skills-marketplace-listing*.
  expect(score('sk', 'skills')).toBeGreaterThan(score('sk', 'skills marketplace listing'))
})

test('a match near the front beats one buried in the middle', () => {
  expect(score('run', 'a run of things')).toBeGreaterThan(score('run', 'somewhere much later a run'))
})

const over: Searchable[] = [
  { tab: 'skills', kind: 'skill', label: 'folding-laundry', detail: 'installed here' },
  { tab: 'skills', kind: 'learned skill', label: 'sorting-downloads', detail: 'sort my downloads by year' },
  { tab: 'activity', kind: 'run', label: 'sort my downloads', detail: 'answered' },
  { tab: 'plugins', kind: 'plugin', label: 'Voice' },
  { tab: 'tools', kind: 'tool', label: 'transcribe', detail: 'voice · reads only' },
]

test('the label is what somebody is aiming at, and the detail counts for less', () => {
  const hits = search('sort my downloads', over)
  // The run is called that; the learned skill only mentions it. Both come back, and the one
  // whose name it is comes first — the detail is the line you read after finding the row.
  expect(hits[0]?.kind).toBe('run')
  expect(hits.map((hit) => hit.kind)).toContain('learned skill')
})

test('a query returns the same order every time', () => {
  // A palette whose second and third rows swap between keystrokes is one nobody trusts to
  // press Enter on.
  const once = search('o', over).map((hit) => hit.label)
  const twice = search('o', [...over].reverse()).map((hit) => hit.label)
  expect(once).toEqual(twice)
})

test('nothing typed finds nothing, and there is a ceiling on what comes back', () => {
  expect(search('   ', over)).toEqual([])
  const many = Array.from({ length: 40 }, (_, n) => ({ tab: 'activity', kind: 'run', label: `run number ${String(n)}` }))
  // A palette that fills the screen is a list, and a list is what the tab bar already is.
  expect(search('run', many)).toHaveLength(MOST)
})

test('a hit carries where it lives, which is the whole of what the palette does', () => {
  // It navigates; it does not execute. What comes back is a tab — and for a plugin that is
  // the plugins page, which since D118 is the only place a plugin lives.
  expect(search('Voice', over)[0]).toMatchObject({ tab: 'plugins', kind: 'plugin' })
})
