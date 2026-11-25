// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { closeByKey, items, soon, stale, weekly } from '../ledger.js'

/** `notice.items` and `notice.done`, chosen and closed without a wire, a host or a process. */

const DAY = 86_400_000
const NOW = Date.parse('2026-08-29T09:00:00Z')
const row = (over) => ({ rowid: 1, text: 'Send the grant draft', by: '2026-09-02', mine: 1, state: 'open', nudges: 0, ...over })

/** A `promises` table in memory, with the two calls `closeByKey` makes. */
const store = (rows) => ({
  select: async (_table, { where }) => rows.filter((r) => r.rowid === where.rowid),
  update: async (_table, set, where) => {
    for (const r of rows.filter((x) => x.rowid === where.rowid)) Object.assign(r, set)
  },
})

test('due_in_four_days_is_an_item_with_dueAt', () => {
  const [item, ...rest] = items([row({ by: '2026-09-02' })], NOW, 120)
  expect(rest).toEqual([])
  // 17:00 local at +02:00 is 15:00 UTC.
  expect(item.dueAt).toBe(Date.parse('2026-09-02T15:00:00Z'))
  // The scheduler's radar decides how loud; the plugin does not say.
  expect(item.urgency).toBeUndefined()
  expect(item.text).toContain('Send the grant draft')
  expect(item.text).toContain('by 2026-09-02')
  // Past the horizon is not an item yet.
  expect(items([row({ by: '2026-09-20' })], NOW, 120, 7)).toEqual([])
})

test('overdue_is_an_item', () => {
  const [item] = items([row({ by: '2026-08-20' })], NOW)
  expect(item.dueAt).toBe(Date.parse('2026-08-20T17:00:00Z'))
  expect(item.text).toContain('was due 2026-08-20')
  expect(soon([row({ by: '2026-08-20' }), row({ rowid: 2, by: '2026-08-29' })], '2026-08-29', 0).map((r) => r.rowid)).toEqual([1, 2])
})

test('no_day_raised_weekly', () => {
  const undated = row({ by: undefined })
  // Never raised: an item, Low.
  const [item] = items([undated], NOW)
  expect(item).toMatchObject({ key: 'commitments:1', urgency: 'low', why: 'Still open, no day set.' })
  expect(item.dueAt).toBeUndefined()
  // Raised yesterday, or exactly seven days ago: not yet.
  expect(stale([{ ...undated, raised_at: NOW - DAY }], NOW)).toEqual([])
  expect(stale([{ ...undated, raised_at: NOW - 7 * DAY }], NOW)).toEqual([])
  // Raised eight days ago: again.
  expect(stale([{ ...undated, raised_at: NOW - 8 * DAY }], NOW)).toHaveLength(1)
  expect(items([{ ...undated, raised_at: NOW - 8 * DAY }], NOW)).toHaveLength(1)
})

test('kept_and_dropped_never_items', () => {
  const rows = [
    row({ rowid: 1, state: 'kept' }),
    row({ rowid: 2, state: 'dropped' }),
    row({ rowid: 3, state: 'kept', by: undefined }),
    row({ rowid: 4, state: 'dropped', by: '2026-08-01' }),
  ]
  expect(items(rows, NOW)).toEqual([])
})

test('keys_are_prefixed', () => {
  const found = items([row({ rowid: 12 }), row({ rowid: 13, by: undefined })], NOW)
  expect(found.map((i) => i.key)).toEqual(['commitments:12', 'commitments:13'])
})

test('notice_done_closes_own_key_only', async () => {
  const rows = [row({ rowid: 5 }), row({ rowid: 6 })]
  const table = store(rows)
  // Somebody else's key, a malformed one, a missing row: nothing changes.
  for (const key of ['tasks:5', 'commitments:', 'commitments:5x', 'commitments:99', '', undefined]) {
    expect(await closeByKey(table, key)).toEqual({ closed: false })
  }
  expect(rows.map((r) => r.state)).toEqual(['open', 'open'])
  // Its own key closes it as kept — and only that one.
  expect(await closeByKey(table, 'commitments:5')).toEqual({ closed: true })
  expect(rows.map((r) => r.state)).toEqual(['kept', 'open'])
  // Already closed: not closed again.
  expect(await closeByKey(table, 'commitments:5')).toEqual({ closed: false })
  rows[1].state = 'dropped'
  expect(await closeByKey(table, 'commitments:6')).toEqual({ closed: false })
  expect(rows[1].state).toBe('dropped')
})

test('why_says_whose', () => {
  const [mine, asked] = items([row({ rowid: 1, mine: 1 }), row({ rowid: 2, mine: 0 })], NOW)
  expect(mine.why).toBe('You said you would.')
  expect(asked.why).toBe('You were asked to.')
  expect(mine.text).toContain('you said')
  expect(asked.text).toContain('you were asked')
})

test('the weekly section counts open and lists the overdue, and is empty with nothing open', () => {
  const rows = [row({ rowid: 1, by: '2026-08-20' }), row({ rowid: 2, by: '2026-09-30' }), row({ rowid: 3, state: 'kept' })]
  const [head, ...lines] = weekly(rows, '2026-08-29').split('\n')
  expect(head).toBe('Promises: 2 open, 1 overdue')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('was due 2026-08-20')
  expect(weekly([row({ state: 'kept' })], '2026-08-29')).toBe('')
})

test('the manifest and the tools promise the three capabilities, and notice.items is the only one that does not write', () => {
  const here = join(import.meta.dirname, '..')
  const manifest = JSON.parse(readFileSync(join(here, 'plugin.json'), 'utf8'))
  expect(manifest.provides).toEqual(expect.arrayContaining(['notice.items', 'notice.done', 'brief.section', 'commitments.due']))
  const source = readFileSync(join(here, 'index.js'), 'utf8')
  for (const cap of ['notice.items', 'notice.done', 'brief.section']) {
    expect(source).toContain(`_meta: { 'alexia/provides': ['${cap}'] }`)
  }
  expect(source).toMatch(/'notice_done',[\s\S]*?readOnlyHint: false, destructiveHint: false[\s\S]*?'alexia\/provides': \['notice\.done'\]/)
})
