// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { friendly, MOST, score, search, SETTINGS, type Searchable } from '../src/palette.js'

/**
 * The palette's ranking (M6-10).
 *
 * A few dozen lines and no dependency, because this is ranking short in-memory lists rather
 * than tuning relevance. What is worth holding still is the **shape of the ladder** — exact,
 * then starts-with, then a word starting with it, then every word typed starting a word, then
 * one slip — because that shape is what makes typing three letters land on the thing you
 * meant. And that a match begins where a word begins: letters scattered through a name are
 * not a match.
 */

test('the ladder, in order', () => {
  expect(score('voice', 'voice')).toBeGreaterThan(score('voice', 'voice notes'))
  expect(score('voice', 'voice notes')).toBeGreaterThan(score('voice', 'the voice panel'))
  // One slip is still a match, and the weakest kind.
  expect(score('vocie', 'voice')).toBeGreaterThan(0)
  expect(score('vocie', 'voice')).toBeLessThan(score('voice', 'the voice panel'))
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
  { tab: 'runs', kind: 'run', label: 'sort my downloads', detail: 'answered' },
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
  const once = search('so', over).map((hit) => hit.label)
  const twice = search('so', [...over].reverse()).map((hit) => hit.label)
  expect(once.length).toBeGreaterThan(1)
  expect(once).toEqual(twice)
})

test('nothing typed finds nothing, and there is a ceiling on what comes back', () => {
  expect(search('   ', over)).toEqual([])
  const many = Array.from({ length: 40 }, (_, n) => ({ tab: 'runs', kind: 'run', label: `run number ${String(n)}` }))
  // A palette that fills the screen is a list, and a list is what the tab bar already is.
  expect(search('run', many)).toHaveLength(MOST)
})

test('a hit carries where it lives, which is the whole of what the palette does', () => {
  // It navigates; it does not execute. What comes back is a tab — and for a plugin that is
  // the plugins page, which since D118 is the only place a plugin lives.
  expect(search('Voice', over)[0]).toMatchObject({ tab: 'plugins', kind: 'plugin' })
})

test('letters scattered through a name are not a match', () => {
  // *hey* used to find a long skill with an h, an e and a y somewhere in it.
  expect(score('hey', 'how-to-write-every-weekly-report-for-you')).toBe(0)
  expect(score('vce', 'voice')).toBe(0)
  // And a word inside another word is not that word: *edit* is not in *credit*.
  expect(score('edit', 'credit card')).toBe(0)
  expect(score('edit', 'Edit layout')).toBeGreaterThan(0)
  expect(score('layout', 'Edit layout')).toBeGreaterThan(0)
})

test('the words typed may be in any order, and a slip is forgiven only from three letters', () => {
  expect(score('money spend', 'spending money')).toBeGreaterThan(0)
  expect(score('down sort', 'sort my downloads')).toBeGreaterThan(0)
  // Two letters swapped in a short word, or one wrong in a longer one.
  expect(score('teh', 'the theme')).toBeGreaterThan(0)
  expect(score('thmee', 'Theme')).toBeGreaterThan(0)
  expect(score('pluign', 'Plugins')).toBeGreaterThan(0)
  // But one wrong letter in three is a different word, and two letters never slip.
  expect(score('hey', 'help')).toBe(0)
  expect(score('xl', 'll')).toBe(0)
})

test('a tool reads as words, not as its id', () => {
  expect(friendly('accept_suggestion')).toBe('Accept suggestion')
  expect(friendly('read-file.now')).toBe('Read file now')
})

test('settings are found by what they are called and by what they do', () => {
  const first = (query: string): Searchable | undefined => search(query, SETTINGS)[0]
  expect(first('theme')).toMatchObject({ tab: 'general', label: 'Theme' })
  expect(first('dark')).toMatchObject({ tab: 'general', label: 'Theme' })
  expect(first('api key')).toMatchObject({ tab: 'models', label: 'Keys and providers' })
  expect(first('monthly budget')).toMatchObject({ tab: 'safety', label: 'Monthly budget' })
  expect(first('permission')).toMatchObject({ tab: 'safety', label: 'What she may do' })
  expect(first('login')).toMatchObject({ tab: 'general', label: 'Start at login' })
  expect(first('hotkey')).toMatchObject({ tab: 'general', label: 'Keyboard shortcut' })
  expect(first('updates')).toMatchObject({ tab: 'about', label: 'Updates' })
  // The unseen words are never sent to the screen.
  expect(search('dark', SETTINGS)[0]).not.toHaveProperty('words')
})

test('a hit carries what to type into the list it lives in', () => {
  const tool: Searchable = { tab: 'tools', kind: 'tool', label: 'Accept suggestion', filter: 'accept_suggestion' }
  expect(search('accept', [tool])[0]).toMatchObject({ label: 'Accept suggestion', filter: 'accept_suggestion' })
})
