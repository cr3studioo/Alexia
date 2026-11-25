// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { between, dayEntry, dayOf, dayPrompt, plainEntry, section, upsert, weekLines } from '../timeline.js'

/** The timeline's rules, argued with without a database or a model in the room. */

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0) // Wed 25 Nov 2026

test('one_entry_per_day', () => {
  const table = []
  const write = (date, text, at) => {
    const change = upsert(table, date, text, at)
    if (change?.insert) table.push({ ...change.insert, rowid: table.length + 1 })
    if (change?.update) {
      Object.assign(table.find((row) => row.rowid === change.update.rowid), change.update.set)
      for (const rowid of change.remove) table.splice(table.findIndex((row) => row.rowid === rowid), 1)
    }
    return change
  }
  write('2026-11-24', 'Met Petr about the grant.', 1)
  write('2026-11-25', 'Finished the draft.', 2)
  // The same day written again: the one row is rewritten, never a second one.
  write('2026-11-24', 'Met Petr about the grant, and booked the train.', 3)
  expect(table.filter((row) => row.date === '2026-11-24')).toHaveLength(1)
  expect(table).toHaveLength(2)
  expect(table.find((row) => row.date === '2026-11-24').text).toContain('booked the train')
  // The same text again changes nothing at all.
  expect(write('2026-11-24', 'Met Petr about the grant, and booked the train.', 4)).toBeNull()
  // A table that already holds two rows for a day is repaired down to one.
  const doubled = [
    { rowid: 1, date: '2026-11-20', text: 'a' },
    { rowid: 2, date: '2026-11-20', text: 'b' },
  ]
  expect(upsert(doubled, '2026-11-20', 'c', 9)).toEqual({ update: { rowid: 1, set: { text: 'c', at: 9 } }, remove: [2] })
  // Nothing and nonsense are not days.
  expect(upsert([], '2026-11-20', '   ', 1)).toBeNull()
  expect(upsert([], 'yesterday', 'text', 1)).toBeNull()
})

test('weekly_section_lists_days', () => {
  const rows = [
    { rowid: 1, date: '2026-11-17', text: 'Too old for this week.' },
    { rowid: 2, date: '2026-11-19', text: 'Dentist in the morning.' },
    { rowid: 3, date: '2026-11-24', text: 'Met Petr about the grant.' },
    { rowid: 4, date: '2026-11-25', text: 'Finished the draft.' },
    { rowid: 5, date: '2026-11-26', text: 'Tomorrow is not a day yet.' },
  ]
  const weekly = section('weekly', rows, NOW, 0)
  expect(weekly.title).toBe('Your days')
  expect(weekly.text.split('\n')).toEqual([
    '2026-11-19: Dentist in the morning.',
    '2026-11-24: Met Petr about the grant.',
    '2026-11-25: Finished the draft.',
  ])
  // Any other kind has nothing to say: empty text is nothing to say.
  expect(section('morning', rows, NOW, 0).text).toBe('')
  expect(section('evening', rows, NOW, 0).text).toBe('')
  // The owner's own clock decides which day it is: 23:30 UTC is already the 26th in Prague.
  const late = Date.UTC(2026, 10, 25, 23, 30)
  expect(dayOf(late, 60)).toBe('2026-11-26')
  expect(weekLines(rows, '2026-11-26')).toContain('2026-11-26: Tomorrow is not a day yet.')
})

test('days_between_two_dates_come_oldest_first', () => {
  const rows = [
    { rowid: 2, date: '2026-11-24', text: 'b' },
    { rowid: 1, date: '2026-11-20', text: 'a' },
    { rowid: 3, date: '2026-11-25', text: 'c' },
  ]
  expect(between(rows, '2026-11-21', undefined).map((row) => row.text)).toEqual(['b', 'c'])
  expect(between(rows, undefined, '2026-11-24').map((row) => row.text)).toEqual(['a', 'b'])
  expect(between(rows).map((row) => row.text)).toEqual(['a', 'b', 'c'])
})

test('the_models_day_is_cut_to_five_sentences_and_nothing_is_a_no', () => {
  const long = Array.from({ length: 9 }, (_, i) => `Sentence number ${i + 1} says something.`).join(' ')
  const entry = dayEntry(`"${long}"`)
  expect(entry.match(/Sentence number/g)).toHaveLength(5)
  expect(dayEntry('2026-11-24: Met Petr.\n- Went home.')).toBe('Met Petr. Went home.')
  expect(dayEntry('NONE')).toBeNull()
  expect(dayEntry('  ')).toBeNull()
  // With no model, the notes themselves, plainly, and never more than five.
  expect(plainEntry(['Met Petr.', 'Went home'])).toBe('Met Petr. Went home.')
  expect(plainEntry(['a', 'b', 'c', 'd', 'e', 'f', 'g']).split('. ')).toHaveLength(5)
  expect(plainEntry([])).toBeNull()
  // What the model is shown is what was written that day, and the limit it is held to.
  const prompt = dayPrompt('2026-11-24', { facts: ['Met Petr.'], dates: ['Grant (2026-12-01)'], exchanges: ['I booked the train'] })
  expect(prompt).toContain('At most 5 sentences')
  expect(prompt).toContain('- Met Petr.')
  expect(prompt).toContain('- Grant (2026-12-01)')
})
