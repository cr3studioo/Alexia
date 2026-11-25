// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { addDays, dueCount, grade, newCard, parseCards } from '../cards.js'

const TODAY = '2026-12-01'

test('right_moves_up_and_spaces', () => {
  let card = newCard({ q: 'Q', a: 'A' }, TODAY)
  expect(card).toMatchObject({ box: 1, due: TODAY })
  const seen = []
  for (let i = 0; i < 6; i += 1) {
    card = { ...card, ...grade(card, true, TODAY) }
    seen.push([card.box, card.due])
  }
  // Boxes 2..5 are 2, 4, 8 and 16 days out; the top box stays there.
  expect(seen).toEqual([
    [2, addDays(TODAY, 2)],
    [3, addDays(TODAY, 4)],
    [4, addDays(TODAY, 8)],
    [5, addDays(TODAY, 16)],
    [5, addDays(TODAY, 16)],
    [5, addDays(TODAY, 16)],
  ])
  expect(addDays('2026-12-30', 4)).toBe('2027-01-03')
})

test('wrong_back_to_box_one', () => {
  expect(grade({ box: 4 }, false, TODAY)).toEqual({ box: 1, due: '2026-12-02' })
  expect(grade({ box: 1 }, false, TODAY)).toEqual({ box: 1, due: '2026-12-02' })
})

test('due_today_count', () => {
  const cards = [
    { rowid: 1, box: 1, due: '2026-11-30' },
    { rowid: 2, box: 2, due: TODAY },
    { rowid: 3, box: 3, due: '2026-12-02' },
    { rowid: 4, box: 1, due: null },
  ]
  expect(dueCount(cards, TODAY)).toBe(2)
  expect(dueCount([], TODAY)).toBe(0)
})

test('parses question lines and ignores the rest', () => {
  const text = 'Here you go:\n1. Q: What is ATP? | A: The energy currency.\n- Q: Where is it made?\n  A: Mitochondria\nnoise\nQ: no answer'
  expect(parseCards(text)).toEqual([
    { q: 'What is ATP?', a: 'The energy currency.' },
    { q: 'Where is it made?', a: 'Mitochondria' },
  ])
})
