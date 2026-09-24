// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { duplicate, parse, plan, prompt, replaces, SHOWN, TRIES } from '../capture.js'
import { REVIEW_AFTER } from '../garden.js'

/**
 * Noticing (M7-3), and specifically the four details that were paid for once already.
 *
 * Every one of these is a failure that actually happened on the predecessor, so each test
 * is named after the failure rather than after the function. The pipeline's storage half
 * lives in `index.js`; everything that decides anything is here, which is what makes it
 * arguable without a database or a model in the room.
 */

const note = (name, text) => ({ name, text })

test('a model very sure about a duplicate is overruled by the text', () => {
  // 2026-08-10, live: a batch of twenty-four real candidates came back all marked duplicate.
  // Valid JSON, nothing written, nothing crashed — the worst shape a failure can take.
  const held = [note('the grant', 'The grant application is due in March.')]

  const wrong = { name: 'the dog', text: 'His dog is called Bruno.', kind: 'person', links: [], duplicateOf: 'the grant' }
  expect(duplicate(wrong, held[0])).toBe(false)
  expect(plan([wrong], held).map((one) => one.text)).toEqual(['His dog is called Bruno.'])

  // And a real one is still believed, because the point is not to write everything twice.
  const right = {
    name: 'the grant again',
    text: 'The grant application is due in March.',
    kind: 'fact',
    links: [],
    duplicateOf: 'the grant',
  }
  expect(duplicate(right, held[0])).toBe(true)
  expect(plan([right], held)).toEqual([])
})

test('a duplicate claim naming a note that does not exist is not a claim', () => {
  const candidate = { name: 'the car', text: 'He drives a red Skoda.', kind: 'fact', links: [], duplicateOf: 'a note nobody wrote' }
  expect(duplicate(candidate, undefined)).toBe(false)
  expect(plan([candidate], [])).toHaveLength(1)
})

test('a link to a note nobody has is dropped rather than written', () => {
  // A link pointing at nothing reads on screen as a memory that has gone missing, which is
  // worse than no link: it makes somebody go looking for something that was never there.
  const held = [note('work', 'He is doing a PhD at CTU FEL.')]
  const candidate = {
    name: 'the grant',
    text: 'The grant application is due in March.',
    kind: 'task',
    links: ['work', 'his imaginary hobby'],
    duplicateOf: '',
  }
  expect(plan([candidate], held)[0].links).toEqual(['work'])
})

test('one note can sit under two parents, and a later candidate can link to an earlier one', () => {
  const held = [note('work', 'He is doing a PhD at CTU FEL.'), note('running', 'He runs most mornings.')]
  const both = { name: 'the race', text: 'He is running a half marathon in April.', kind: 'task', links: ['running', 'work'], duplicateOf: '' }
  const after = { name: 'the shoes', text: 'He bought new running shoes for it.', kind: 'fact', links: ['the race'], duplicateOf: '' }

  const written = plan([both, after], held)
  expect(written[0].links).toEqual(['running', 'work'])
  // The second one links to the first, which was not in the database when the batch began.
  // A pass that only looked at what was stored would get this wrong once per batch, forever.
  expect(written[1].links).toEqual(['the race'])
})

test('the same sentence twice in one batch is written once', () => {
  const same = { name: 'a', text: 'He prefers tea.', kind: 'preference', links: [], duplicateOf: '' }
  expect(plan([same, { ...same, name: 'b' }], [])).toHaveLength(1)
})

test('an answer that is not JSON is a failure the rows survive, not an empty result', () => {
  // The difference matters: `[]` means *nothing worth keeping* and the buffer drains, while
  // `null` means *ask again*. Confusing them is how an hour of conversation disappears.
  expect(parse('here you go: [ {"text": "He prefers tea."} ] hope that helps')).toEqual([
    { name: 'He prefers tea.', text: 'He prefers tea.', kind: 'other', links: [], duplicateOf: '', replaces: '', timeBound: false, pin: false },
  ])
  // Saying nothing, in the format. The buffer drains on this one and only this one.
  expect(parse('nothing much in there: []')).toEqual([])

  // Everything else is the model not answering. Prose, an answer the token limit cut in
  // half, an object where an array was asked for — the rows survive all three.
  expect(parse('I had a look and there was nothing much in there.')).toBeNull()
  expect(parse('[ {"text": "unclosed" ')).toBeNull()
  expect(parse('{"text": "an object, not an array"}')).toBeNull()

  // Three tries before a batch is set aside, and set aside is not discarded.
  expect(TRIES).toBe(3)
})

test('the prompt shows the notes that exist, because a link can only point at one of those', () => {
  const asked = prompt([{ text: 'They said: my dog is called Bruno' }], [note('work', 'He is doing a PhD at CTU FEL.'), 'the grant'])
  // Name and text: whether a new sentence makes an old one out of date needs the old words.
  expect(asked).toContain('- "work": He is doing a PhD at CTU FEL.')
  expect(asked).toContain('- "the grant"')
  expect(asked).toContain('my dog is called Bruno')
  // The low bar, in the prompt rather than in a comment about the prompt. A fact never
  // written cannot be recalled; a trivial one costs almost nothing to skip past.
  expect(asked).toContain('When in doubt, keep it.')

  // Nothing written yet is said out loud rather than left as an empty list, which a small
  // model reads as *there is a list and I cannot see it*.
  expect(prompt([], [])).toContain('(none yet)')
})

/**
 * Truth over time (Phase B): Mem0's four operations, with the model's claims checked by code.
 * `plan` sees only valid notes; a held note with a rowid is one that is stored.
 */
const held = (rowid, name, text, more = {}) => ({ rowid, name, text, source: 'stated', ...more })
const candidate = (name, text, more = {}) => ({ name, text, kind: 'fact', links: [], duplicateOf: '', replaces: '', pin: false, ...more })

test('the prompt carries today, asks for dates instead of relative time, and shows at most SHOWN notes', () => {
  const many = Array.from({ length: SHOWN + 5 }, (_, i) => note(`note ${i}`, `Sentence number ${i}.`))
  const asked = prompt([], many, new Date(Date.UTC(2026, 8, 23)))
  expect(asked).toContain('Today is 2026-09-23.')
  expect(asked).toContain('started at ČVUT FEL in September 2026')
  expect(asked).toContain('time_bound')
  expect(asked).toContain('replaces')
  // Newest first in, so the cut drops the oldest.
  expect(asked).toContain(`"note ${SHOWN - 1}"`)
  expect(asked).not.toContain(`"note ${SHOWN}"`)
})

test('the model’s replaces and time_bound are read, and only a real true is true', () => {
  const [one] = parse('[{"text": "He lives in Brno.", "replaces": " where he lives ", "time_bound": true}]')
  expect(one.replaces).toBe('where he lives')
  expect(one.timeBound).toBe(true)
  const [other] = parse('[{"text": "He lives in Brno.", "replaces": 7, "time_bound": "yes"}]')
  expect(other.replaces).toBe('')
  expect(other.timeBound).toBe(false)
})

test('UPDATE: a replace naming a real note on the same subject closes it', () => {
  const old = held(4, 'where he lives', 'He lives in Prague.')
  const [written] = plan([candidate('where he lives', 'He lives in Brno since August 2026.', { replaces: 'where he lives' })], [old])
  // Shares only *lives* — a replacement is supposed to say something different.
  expect(written.replaces).toBe(4)
  expect(written).not.toHaveProperty('suggestReplaces')
})

test('a replace claim about something else entirely is overruled, and the candidate is just added', () => {
  // The 2026-08-10 failure with a different field name: a model calling everything a replace
  // would retire the table one batch at a time.
  const old = held(4, 'where he lives', 'He lives in Prague.')
  const wrong = candidate('the dog', 'His dog is called Bruno.', { replaces: 'where he lives' })
  expect(replaces(wrong, old)).toBe(false)
  const [written] = plan([wrong], [old])
  expect(written.text).toBe('His dog is called Bruno.')
  expect(written).not.toHaveProperty('replaces')

  // A name that is not a held note is not a claim either.
  expect(plan([candidate('x', 'He lives in Brno.', { replaces: 'nowhere' })], [old])[0]).not.toHaveProperty('replaces')
  // And the words every note about a person shares are not a subject.
  expect(replaces(candidate('x', 'The user prefers tea.'), held(1, 'y', 'The user prefers short answers.'))).toBe(false)
})

test('a pinned note is never closed by the sorting pass — the replacement is only a suggestion', () => {
  const name = held(2, 'his name', 'His name is Vaclav.', { pinned: 1 })
  const [written] = plan([candidate('his name', 'His name is Václav Nejedlý, and he goes by Vašek.', { replaces: 'his name' })], [name])
  expect(written.suggestReplaces).toBe(2)
  expect(written).not.toHaveProperty('replaces')
})

test('NOOP still wins over UPDATE, and one note cannot be replaced twice in a batch', () => {
  const old = held(4, 'where he lives', 'He lives in Prague.')
  // A real duplicate is dropped even if it also claims to replace.
  expect(plan([candidate('again', 'He lives in Prague.', { duplicateOf: 'where he lives', replaces: 'where he lives' })], [old])).toEqual([])

  const first = candidate('where he lives', 'He lives in Brno.', { replaces: 'where he lives' })
  const second = candidate('city', 'He lives in Ostrava.', { replaces: 'where he lives' })
  const written = plan([first, second], [old])
  expect(written[0].replaces).toBe(4)
  // The second names the note written a moment ago, which has no rowid yet: added, not replacing.
  expect(written[1]).not.toHaveProperty('replaces')
})

test('time-bound notes are due for a check REVIEW_AFTER from now; others never are', () => {
  const now = 5_000
  const [bound, lasting] = plan(
    [candidate('study', 'He started at ČVUT FEL in September 2026.', { timeBound: true }), candidate('tea', 'He likes tea.')],
    [],
    now,
  )
  expect(bound.timeBound).toBe(true)
  expect(bound.reviewAt).toBe(now + REVIEW_AFTER)
  expect(lasting).not.toHaveProperty('reviewAt')
})
