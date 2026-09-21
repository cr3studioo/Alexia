// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { asHeard, LENGTHS } from '../writing.js'

/**
 * **Hear her at a length** (D189): which length the chat gives her now, which she was heard at,
 * on what — and, on a paid model, that it was paid and what it cost.
 */

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'plugin.json'), 'utf8'))
const samples = (told) => [
  { ask: 'Who are you?', model: 'm', said: 'I am her.', told },
  { ask: 'What do you do unasked?', model: 'm', said: 'I chase dates.', told },
]

test('the sample says which length the chat gives her now, and which one this is', () => {
  const said = asHeard(samples({ sent: 'medium', model: 'Big 70B', paid: false, cost: 0, matched: true, chat: { model: 'Big 70B', size: 'medium' } }), true)
  expect(said).toContain('In your chat right now, Big 70B answers first and is given her medium (about 300 words) version.')
  expect(said).toContain('This sample is her medium (about 300 words) version, on Big 70B.')
  expect(said).not.toContain('paid')
})

test('a sample on a paid model says so, and what it cost, every time', () => {
  const said = asHeard(samples({ sent: 'high', asked: 'high', model: 'Paid One', paid: true, cost: 0.0045, matched: true, chat: { model: 'Big 70B', size: 'medium' } }), true)
  // Two questions, two charges: the whole of it.
  expect(said).toContain('⚠ Paid One is a paid model: hearing her cost about $0.0090.')
  expect(said).toContain('Paid models are on under Models')
})

test('the full one with paid off is heard on the strongest free model, and says it is not what the chat would use', () => {
  const said = asHeard(samples({ sent: 'high', asked: 'high', model: 'Big 70B', paid: false, cost: 0, matched: false }), true)
  expect(said).toContain('only paid models are given the full version in the chat, and paid models are off under Models')
})

test('a length she does not have yet is said, rather than passed off as the one asked for', () => {
  const said = asHeard(samples({ sent: 'high', asked: 'small', model: 'Tiny 2B', paid: false, cost: 0, matched: true }), false)
  expect(said).toContain('she has no short (about 100 words) version yet; Re-adapt writes all three')
})

test('an Alexia too old to say keeps the old sentence', () => {
  const said = asHeard([{ ask: 'Who are you?', model: 'm', said: 'I am her.' }], true)
  expect(said).toContain('This is her full-length document')
})

test('the choice is a setting with one card per length, and the full one warns about money before anybody presses', () => {
  const choice = manifest.settings.find((one) => one.key === 'hear_length')
  expect(choice).toMatchObject({ type: 'choice', default: 'chat' })
  expect(choice.options.map((one) => one.value)).toEqual(['chat', ...LENGTHS])
  expect(choice.options.find((one) => one.value === 'high').hint).toContain('costs money')
})
