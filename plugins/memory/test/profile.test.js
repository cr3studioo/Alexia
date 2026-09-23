// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { plan } from '../capture.js'
import { CAP, cityOnly, pinnedOf, profile, seedable } from '../profile.js'

/**
 * The profile (`memory.profile`): what Alexia reads before every task. Everything in it is paid
 * for in every prompt, and a wrong sentence in it is wrong on every task, so the tests are
 * about what gets in, in what order, and what never does.
 */

const note = (text, more = {}) => ({ text, source: 'stated', pinned: 1, at: 1, ...more })

test('pinned notes only, what they said before what was worked out, newest first within each', () => {
  const rows = [
    note('He prefers tea.', { at: 1 }),
    note('He wants the assistant to answer in Czech.', { at: 3 }),
    note('He runs most mornings.', { at: 5, pinned: null }),
    note('He probably works late.', { at: 9, source: 'inferred' }),
    note('His name is Vaclav.', { at: 2 }),
  ]
  expect(profile(rows)).toBe(
    ['- He wants the assistant to answer in Czech.', '- His name is Vaclav.', '- He prefers tea.', '- He probably works late.'].join(
      '\n',
    ),
  )
})

test('nothing pinned is an empty string, which core reads as nothing to add', () => {
  expect(profile([])).toBe('')
  expect(profile([note('He prefers tea.', { pinned: 0 }), note('Older row.', { pinned: undefined })])).toBe('')
})

test('the cap drops whole lines, never half a sentence, and a long one does not crowd out the rest', () => {
  const long = 'x'.repeat(CAP)
  const rows = [note('First, newest.', { at: 3 }), note(`${long}.`, { at: 2 }), note('Third, still fits.', { at: 1 })]
  const said = profile(rows)
  expect(said).toBe('- First, newest.\n- Third, still fits.')
  expect(said.length).toBeLessThanOrEqual(CAP)

  // Many short ones: stops at the cap, every line whole, the oldest are what go.
  const many = Array.from({ length: 60 }, (_, i) => note(`Note number ${i} is a sentence of some length.`, { at: i }))
  const cut = profile(many)
  expect(cut.length).toBeLessThanOrEqual(CAP)
  for (const line of cut.split('\n')) expect(line).toMatch(/^- Note number \d+ is a sentence of some length\.$/)
  expect(cut.startsWith('- Note number 59 ')).toBe(true)
})

test('storage hands a pin back as 1, true, 0, or not at all', () => {
  expect(pinnedOf({ pinned: 1 })).toBe(true)
  expect(pinnedOf({ pinned: true })).toBe(true)
  expect(pinnedOf({ pinned: 0 })).toBe(false)
  expect(pinnedOf({ pinned: null })).toBe(false)
  expect(pinnedOf({})).toBe(false)
})

test('where somebody lives goes in as the city and nothing finer', () => {
  // The owner's rule: the profile goes to whichever model answers, every time.
  expect(cityOnly('Vaclav lives in Praha 6.')).toBe('Vaclav lives in Praha.')
  expect(cityOnly('He lives in Prague 6.')).toBe('He lives in Prague.')
  expect(cityOnly('Bydlí v Praze 6.')).toBe('Bydlí v Praze.')
  expect(cityOnly('He lives in Praha 6-Dejvice.')).toBe('He lives in Praha.')
  expect(cityOnly('He lives in Prague 10 – Vršovice, near the park.')).toBe('He lives in Prague, near the park.')
  expect(cityOnly('He lives at Vinohradská 1234/56, Praha 2.')).toBe('He lives in Praha.')
  expect(cityOnly('Bydlí na Na Příkopě 12/3, 110 00 Praha 1.')).toBe('Bydlí, Praha.')
  expect(cityOnly('He lives at 221B Baker Street, London.')).toBe('He lives in London.')

  // A postcode just after a city is what the router's redaction eats the city for.
  expect(cityOnly('He lives in Prague 16000.')).toBe('He lives in Prague.')
  // And a JSON-shaped key gets its value blanked on the way out, so the key loses its quotes.
  expect(cityOnly('"location": "Prague"')).toBe('location: "Prague"')

  // Everything that is not an address is left alone.
  expect(cityOnly('He wants short answers, in Czech.')).toBe('He wants short answers, in Czech.')
  expect(cityOnly('He has 2 kids and runs 10 km.')).toBe('He has 2 kids and runs 10 km.')
})

test('the profile applies the city rule, and the note itself is not touched', () => {
  const row = note('He lives in Praha 6.')
  expect(profile([row])).toBe('- He lives in Praha.')
  expect(row.text).toBe('He lives in Praha 6.')
})

test('the one-time seed pins who they are and how to talk to them, and nothing it was not told', () => {
  const stated = (text, kind = 'fact') => ({ text, kind, source: 'stated' })
  expect(seedable(stated('He prefers short answers.', 'preference'))).toBe(true)
  expect(seedable(stated('Anything at all, filed as a preference.', 'preference'))).toBe(true)
  expect(seedable(stated('His name is Vaclav.'))).toBe(true)
  expect(seedable(stated('The user’s name is Vaclav Nejedly.'))).toBe(true)
  expect(seedable(stated('His preferred language is Czech.'))).toBe(true)
  expect(seedable(stated('He wants the assistant to be blunt.'))).toBe(true)
  expect(seedable(stated('He lives in Prague.', 'place'))).toBe(true)
  // Older rows have no source at all, and they were all said out loud — capture came later.
  expect(seedable({ text: 'His name is Vaclav.', kind: 'person' })).toBe(true)

  // Worked out rather than said: never, whatever it says.
  expect(seedable({ text: 'His name is Vaclav.', kind: 'preference', source: 'inferred' })).toBe(false)
  // About somebody else.
  expect(seedable(stated('His dog is called Bruno.', 'person'))).toBe(false)
  expect(seedable(stated('His wife prefers tea.', 'person'))).toBe(false)
  expect(seedable(stated('His brother lives in Brno.', 'person'))).toBe(false)
  // True and useful, and not who he is.
  expect(seedable(stated('The grant application is due in March.', 'task'))).toBe(false)
  expect(seedable(stated('He is doing a PhD at CTU FEL.'))).toBe(false)
})

test('the sorting pass never pins: the model’s pin is carried as a suggestion only', () => {
  // A guess in every prompt is how a wrong fact becomes permanent. `plan` writes what the tick
  // stores as `inferred`, and what it says about pinning is `suggestPin`, never `pinned`.
  const [one] = plan([{ name: 'name', text: 'His name is Vaclav.', kind: 'person', links: [], duplicateOf: '', pin: true }], [])
  expect(one.suggestPin).toBe(true)
  expect(one).not.toHaveProperty('pinned')
  const [other] = plan([{ name: 'tea', text: 'He likes tea.', kind: 'preference', links: [], duplicateOf: '', pin: false }], [])
  expect(other.suggestPin).toBe(false)
})
