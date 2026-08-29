// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { duplicate, parse, plan, prompt, TRIES } from '../capture.js'

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
    { name: 'He prefers tea.', text: 'He prefers tea.', kind: 'other', links: [], duplicateOf: '' },
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
  const asked = prompt([{ text: 'They said: my dog is called Bruno' }], ['work', 'the grant'])
  expect(asked).toContain('"work", "the grant"')
  expect(asked).toContain('my dog is called Bruno')
  // The low bar, in the prompt rather than in a comment about the prompt. A fact never
  // written cannot be recalled; a trivial one costs almost nothing to skip past.
  expect(asked).toContain('When in doubt, keep it.')

  // Nothing written yet is said out loud rather than left as an empty list, which a small
  // model reads as *there is a list and I cannot see it*.
  expect(prompt([], [])).toContain('(none yet)')
})
