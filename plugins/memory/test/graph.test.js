// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { parse, plan } from '../capture.js'
import { findGoal, findPerson, fromContacts, nextBirthday, noticeItems, resolveDue, sameName } from '../graph.js'

/** The life graph, decided without a database, a clock or a model in the room. */

const DAY = 86_400_000
// Tuesday 2026-11-24, noon UTC.
const NOW = Date.parse('2026-11-24T12:00:00Z')
const person = (over) => ({ rowid: 1, name: 'Petr', aliases: '[]', relation: 'supervisor', last_seen: NOW, ...over })

test('same_person_by_alias_and_diacritics', () => {
  expect(sameName('Petr', 'Petře')).toBe(true)
  expect(sameName('Petr', 'PETR')).toBe(true)
  expect(sameName('Jiří', 'jiri')).toBe(true)
  // Petra is somebody else.
  expect(sameName('Petr', 'Petra')).toBe(false)
  expect(sameName('Petr', 'Peter')).toBe(false)

  const people = [person({ rowid: 1, aliases: JSON.stringify(['Peter']) }), person({ rowid: 2, name: 'Petra' })]
  expect(findPerson(people, 'Petře')?.rowid).toBe(1)
  // Peter is only Petr because it was written down as an alias.
  expect(findPerson(people, 'Peter')?.rowid).toBe(1)
  expect(findPerson([person({ rowid: 3 })], 'Peter')).toBeUndefined()
  // An exact spelling beats a declined one.
  expect(findPerson(people, 'Petra')?.rowid).toBe(2)
  expect(findPerson(people, '')).toBeUndefined()
})

test('relative_dates_resolve_from_message_time', () => {
  // Said on a Tuesday: next Friday is the Friday after it, three days on.
  expect(resolveDue('next Friday', NOW)).toBe('2026-11-27')
  expect(resolveDue('next Friday at 14:00', NOW)).toBe('2026-11-27T14:00')
  expect(resolveDue('Tuesday', NOW)).toBe('2026-12-01')
  expect(resolveDue('tomorrow', NOW)).toBe('2026-11-25')
  expect(resolveDue('in 10 days', NOW)).toBe('2026-12-04')
  expect(resolveDue('příští pátek', NOW)).toBe('2026-11-27')
  expect(resolveDue('zítra', NOW)).toBe('2026-11-25')
  // The same words a week later land a week later: the plugin counts from `at`, not from today.
  expect(resolveDue('next Friday', NOW + 7 * DAY)).toBe('2026-12-04')
  // A date given outright is kept; a date with no year is the next such date.
  expect(resolveDue('2027-01-15', NOW)).toBe('2027-01-15')
  expect(resolveDue('03-02', NOW)).toBe('2027-03-02')
  expect(resolveDue('11-24', NOW)).toBe('2026-11-24')
  expect(resolveDue('sometime', NOW)).toBeNull()
  expect(resolveDue('2026-02-30', NOW)).toBeNull()
})

test('birthday_in_five_days_is_a_notice', () => {
  const [item, ...rest] = noticeItems({ people: [person({ birthday: '11-29' })] }, NOW)
  expect(rest).toEqual([])
  expect(item.urgency).toBe('low')
  expect(item.dueAt).toBe(Date.parse('2026-11-29T09:00:00Z'))
  expect(item.text).toContain('Petr')
  expect(item.text).toContain('in 5 days')
  // A full date says how old they are turning, and 09:00 is the owner's local 09:00.
  const [aged] = noticeItems({ people: [person({ birthday: '1990-11-29' })] }, NOW, 120)
  expect(aged.text).toContain('(36)')
  expect(aged.dueAt).toBe(Date.parse('2026-11-29T07:00:00Z'))
  expect(nextBirthday('02-29', '2027-01-01')).toBe('2027-02-28')
})

test('birthday_in_ten_days_is_not', () => {
  expect(noticeItems({ people: [person({ birthday: '12-04' })] }, NOW)).toEqual([])
  // Last week's is not next year's yet.
  expect(noticeItems({ people: [person({ birthday: '11-20' })] }, NOW)).toEqual([])
})

test('follow_up_after_three_days', () => {
  const said = (days) => person({ follow_up: "said he'd call back", follow_up_at: NOW - days * DAY })
  expect(noticeItems({ people: [said(2)] }, NOW)).toEqual([])
  const [item] = noticeItems({ people: [said(4)] }, NOW)
  expect(item.why).toBe("You said you'd get back to them.")
  expect(item.urgency).toBe('low')
  expect(item.key).toBe('memory:follow:1')
  expect(item.text).toContain('Petr')
  // Nothing to follow up, nothing said.
  expect(noticeItems({ people: [person({ follow_up: '', follow_up_at: NOW - 9 * DAY })] }, NOW)).toEqual([])
})

test('goal_untouched_fourteen_days', () => {
  const goal = (over) => ({ rowid: 7, text: 'Finish the thesis draft', since: NOW - 40 * DAY, last_touched: NOW - 15 * DAY, state: 'active', ...over })
  const [item] = noticeItems({ goals: [goal()] }, NOW)
  expect(item.key).toBe('memory:goal:7')
  expect(item.urgency).toBe('low')
  expect(item.text).toContain('Finish the thesis draft')
  expect(noticeItems({ goals: [goal({ last_touched: NOW - 13 * DAY })] }, NOW)).toEqual([])
  // Once per fourteen days per goal.
  expect(noticeItems({ goals: [goal({ raised_at: NOW - 3 * DAY })] }, NOW)).toEqual([])
  expect(noticeItems({ goals: [goal({ raised_at: NOW - 15 * DAY })] }, NOW)).toHaveLength(1)
  // Done and dropped goals are left alone.
  expect(noticeItems({ goals: [goal({ state: 'done' }), goal({ state: 'dropped' })] }, NOW)).toEqual([])
  // Saying it again is touching it, not a second goal.
  expect(findGoal([goal()], 'finish thesis draft this month')?.rowid).toBe(7)
  expect(findGoal([goal()], 'learn to sail')).toBeUndefined()
})

test('notice_items_shape_matches_interfaces', () => {
  const dates = [
    { rowid: 3, what: 'Exam in statistics', due: '2026-11-27T10:00', kind: 'event', state: 'open' },
    { rowid: 4, what: 'Grant deadline', due: '2026-12-20', kind: 'deadline', state: 'open' },
    { rowid: 5, what: 'Old thing', due: '2026-11-20', kind: 'event', state: 'open' },
    { rowid: 6, what: 'Done thing', due: '2026-11-26', kind: 'deadline', state: 'done' },
  ]
  const items = noticeItems({ people: [person({ birthday: '11-26' })], dates }, NOW, 0, 7)
  expect(items.map((i) => i.key).sort()).toEqual(['memory:birthday:1:2026-11-26', 'memory:date:3'])
  for (const item of items) {
    expect(item.key.startsWith('memory:')).toBe(true)
    expect(typeof item.text).toBe('string')
    expect(typeof item.why).toBe('string')
    expect(Number.isFinite(item.dueAt)).toBe(true)
    // camelCase on the wire, and only the fields §3.6 names.
    expect(Object.keys(item).every((k) => ['key', 'text', 'why', 'urgency', 'dueAt', 'notBefore'].includes(k))).toBe(true)
  }
  const exam = items.find((i) => i.key === 'memory:date:3')
  expect(exam.dueAt).toBe(Date.parse('2026-11-27T10:00:00Z'))
  // Open dates leave urgency to the scheduler's radar.
  expect(exam.urgency).toBeUndefined()
  // The horizon is the caller's.
  expect(noticeItems({ dates }, NOW, 0, 30).map((i) => i.key)).toContain('memory:date:4')
})

const contactsAnswer = (contacts) => ({ content: [{ type: 'text', text: '' }], structuredContent: { contacts } })

test('contacts_fill_birthday_when_provided', async () => {
  const asked = []
  const ask = async (query) => {
    asked.push(query)
    return contactsAnswer([
      { name: 'Petra Novotná', emails: ['petra@example.com'], phones: [] },
      { name: 'Petr Dvořák', emails: ['petr@example.com'], phones: ['+420 555 000 111'], birthday: '1988-03-14' },
    ])
  }
  const patch = await fromContacts(person(), ask)
  expect(asked).toEqual(['Petr'])
  expect(patch.birthday).toBe('1988-03-14')
  expect(patch.contact).toBe('petr@example.com, +420 555 000 111')
  // What the owner already said is not overwritten by the address book.
  const kept = await fromContacts(person({ birthday: '03-15' }), ask)
  expect(kept.birthday).toBeUndefined()
  expect(kept.contact).toBeDefined()
  // A text-only answer is read too, and `--MM-DD` is a birthday.
  const text = await fromContacts(person(), async () => ({
    content: [{ type: 'text', text: JSON.stringify({ contacts: [{ name: 'Petr', birthday: '--03-14' }] }) }],
  }))
  expect(text.birthday).toBe('03-14')
})

test('no_contacts_provider_is_silent', async () => {
  // Nothing provides it.
  expect(await fromContacts(person(), async () => null)).toEqual({})
  // It is there and fails, or refuses, or knows nobody.
  expect(
    await fromContacts(person(), async () => {
      throw new Error('boom')
    }),
  ).toEqual({})
  expect(await fromContacts(person(), async () => ({ isError: true, content: [{ type: 'text', text: 'no' }] }))).toEqual({})
  expect(await fromContacts(person(), async () => contactsAnswer([]))).toEqual({})
  expect(await fromContacts(person(), async () => contactsAnswer([{ name: 'Jana', birthday: '01-01' }]))).toEqual({})
})

test('capture carries people, dates and goals from the model to the plan, and ignores junk', () => {
  const said = JSON.stringify([
    {
      name: 'Petr',
      text: 'Petr is the supervisor and said he would call back about the thesis.',
      kind: 'person',
      people: [{ name: 'Petr', relation: 'supervisor', birthday: '03-14', follow_up: "said he'd call back" }, { name: '' }, 'junk'],
      dates: [{ what: 'Thesis deadline', due: 'next Friday', kind: 'deadline' }, { what: 'no day', due: '' }],
      goals: [{ text: 'Finish the thesis' }, { text: ' ' }],
    },
    { text: 'He likes tea.' },
  ])
  const [first, second] = parse(said)
  expect(first.people).toEqual([{ name: 'Petr', relation: 'supervisor', birthday: '03-14', followUp: "said he'd call back" }])
  expect(first.dates).toEqual([{ what: 'Thesis deadline', due: 'next Friday', kind: 'deadline' }])
  expect(first.goals).toEqual([{ text: 'Finish the thesis' }])
  expect(second.people).toBeUndefined()
  const [written] = plan([first], [])
  expect(written.people).toHaveLength(1)
  expect(written.dates).toHaveLength(1)
  expect(written.goals).toHaveLength(1)
})
