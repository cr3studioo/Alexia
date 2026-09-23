// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { dayKey, dueNow, morningDue, parseAt, parseHHMM, reminderText, sendTo, TRIES } from '../reminders.js'

// Reminders pushed to the phone, and the morning summary's own "once a day" — both come down
// to comparing a clock against a stored value, which is exactly the kind of arithmetic that
// looks right until it meets a timezone. Every `now` here is built with `new Date(y, m, d, h,
// min)` — local time, the same way `dayKey` reads it back — rather than an ISO string, so
// these tests mean the same thing wherever they run.

const now = new Date(2026, 8, 22, 8, 0).getTime() // 2026-09-22, 08:00 local

test('parseAt accepts a readable time that is not absurdly far off', () => {
  const at = new Date(2026, 8, 22, 9, 0).toISOString()
  const result = parseAt(at, now)
  expect(result.ok).toBe(true)
  expect(result.at).toBe(new Date(at).getTime())
})

test('parseAt rejects a string it cannot read as a date', () => {
  const result = parseAt('sometime soon', now)
  expect(result.ok).toBe(false)
  expect(result.why).toBeTruthy()
})

test('parseAt allows a moment less than a minute in the past (the model was slow to call it)', () => {
  const at = new Date(now - 30_000).toISOString()
  expect(parseAt(at, now).ok).toBe(true)
})

test('parseAt rejects a moment more than a minute in the past', () => {
  const at = new Date(now - 61_000).toISOString()
  expect(parseAt(at, now).ok).toBe(false)
})

test('parseAt rejects a moment more than 366 days ahead', () => {
  const tooFar = new Date(now + 367 * 24 * 60 * 60 * 1000).toISOString()
  const justFar = new Date(now + 300 * 24 * 60 * 60 * 1000).toISOString()
  expect(parseAt(tooFar, now).ok).toBe(false)
  expect(parseAt(justFar, now).ok).toBe(true)
})

test('dueNow returns unsent rows whose time has come, sorted earliest first', () => {
  const rows = [
    { id: 1, text: 'later', at: now + 1000, sent: false },
    { id: 2, text: 'second', at: now - 1000, sent: false },
    { id: 3, text: 'first', at: now - 5000, sent: false },
    { id: 4, text: 'already sent', at: now - 5000, sent: true },
  ]
  expect(dueNow(rows, now).map((r) => r.id)).toEqual([3, 2])
})

test('dueNow is empty for no rows, or nothing due yet', () => {
  expect(dueNow([], now)).toEqual([])
  expect(dueNow(undefined, now)).toEqual([])
  expect(dueNow([{ id: 1, text: 'later', at: now + 1000, sent: false }], now)).toEqual([])
})

test('reminderText is plain when it fires on time', () => {
  const row = { text: 'stretch', at: now }
  expect(reminderText(row, now)).toBe('⏰ stretch')
})

test('reminderText says how late it is once it is more than 2 minutes overdue', () => {
  const at = now - 3 * 60 * 1000
  const row = { text: 'stretch', at }
  expect(reminderText(row, now)).toBe(`⏰ stretch (was due ${new Date(at).toLocaleString()})`)
})

test('reminderText stays plain right up to the 2-minute grace', () => {
  const row = { text: 'stretch', at: now - 2 * 60 * 1000 }
  expect(reminderText(row, now)).toBe('⏰ stretch')
})

test('dayKey is the local YYYY-MM-DD', () => {
  expect(dayKey(now)).toBe('2026-09-22')
  expect(dayKey(new Date(2026, 0, 5).getTime())).toBe('2026-01-05')
})

test('parseHHMM reads a valid time, with or without a leading zero', () => {
  expect(parseHHMM('08:30')).toEqual({ h: 8, m: 30 })
  expect(parseHHMM('8:30')).toEqual({ h: 8, m: 30 })
  expect(parseHHMM('23:59')).toEqual({ h: 23, m: 59 })
  expect(parseHHMM('00:00')).toEqual({ h: 0, m: 0 })
})

test('parseHHMM rejects an out-of-range or malformed time', () => {
  expect(parseHHMM('24:00')).toBeUndefined()
  expect(parseHHMM('12:60')).toBeUndefined()
  expect(parseHHMM('noon')).toBeUndefined()
  expect(parseHHMM('')).toBeUndefined()
  expect(parseHHMM(undefined)).toBeUndefined()
})

test('morningDue is true once the time has come and it has not fired today', () => {
  expect(morningDue('08:00', undefined, now)).toBe(true)
  expect(morningDue('08:00', '2026-09-21', now)).toBe(true)
})

test('morningDue is false before the time has come', () => {
  expect(morningDue('08:01', '2026-09-21', now)).toBe(false)
})

test('morningDue is false once it has already fired today', () => {
  expect(morningDue('08:00', '2026-09-22', now)).toBe(false)
})

test('morningDue is false for an unset or unparseable time', () => {
  expect(morningDue('', undefined, now)).toBe(false)
  expect(morningDue(undefined, undefined, now)).toBe(false)
  expect(morningDue('nonsense', undefined, now)).toBe(false)
})

/**
 * The two rules the clock leans on, and the failures they exist for: a row nobody can deliver
 * becoming a row nobody can get past, and a reminder arriving on the wrong person's phone.
 */

test('dueNow leaves out a row that has run out of tries', () => {
  const rows = [
    { text: 'stuck', at: 1, tries: TRIES },
    { text: 'fine', at: 1 },
    { text: 'trying', at: 1, tries: TRIES - 1 },
  ]
  expect(dueNow(rows, 100).map((row) => row.text)).toEqual(['fine', 'trying'])
})

test('dueNow reads a missing or nonsense tries count as none', () => {
  const rows = [
    { text: 'none', at: 1 },
    { text: 'undefined', at: 1, tries: undefined },
    { text: 'nonsense', at: 1, tries: 'lots' },
  ]
  expect(dueNow(rows, 100)).toHaveLength(3)
})

test('sendTo prefers the chat the reminder was set in', () => {
  expect(sendTo({ chat_id: '111' }, '999')).toBe('111')
  expect(sendTo({ chat_id: 111 }, '999')).toBe(111)
})

test('sendTo falls back to the home chat only for a row that has no chat of its own', () => {
  // What a row written before the column existed looks like.
  expect(sendTo({ text: 'old' }, '999')).toBe('999')
  expect(sendTo({ chat_id: null }, '999')).toBe('999')
  expect(sendTo({ chat_id: '' }, '999')).toBe('999')
  expect(sendTo(undefined, '999')).toBe('999')
  // And nothing at either end is nothing, not a crash.
  expect(sendTo({ text: 'old' }, undefined)).toBeUndefined()
})
