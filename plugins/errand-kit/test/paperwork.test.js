// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { closeByKey, day, docsOf, items, rowidOf } from '../paperwork.js'

const NOW = Date.parse('2026-09-01T09:00:00Z')
const row = (over) => ({ rowid: 1, what: 'Renew passport', due: '2026-09-10', state: 'open', docs: '["photo","old passport"]', ...over })

const store = (rows) => ({
  select: async (_table, { where }) => rows.filter((r) => r.rowid === where.rowid),
  update: async (_table, set, where) => {
    for (const r of rows.filter((x) => x.rowid === where.rowid)) Object.assign(r, set)
  },
})

test('dated_item_is_notice', () => {
  const found = items([row(), row({ rowid: 2, due: undefined }), row({ rowid: 3, state: 'done' })], NOW, 120)
  expect(found).toHaveLength(1)
  expect(found[0].key).toBe('errands:1')
  expect(found[0].text).toContain('Renew passport')
  expect(found[0].text).toContain('2026-09-10')
  expect(found[0].why).toContain('photo')
  // 17:00 local at +02:00 is 15:00 UTC.
  expect(found[0].dueAt).toBe(Date.parse('2026-09-10T15:00:00Z'))
})

test('done_own_key_only', async () => {
  const rows = [row(), row({ rowid: 2, what: 'File taxes' })]
  const s = store(rows)
  expect(await closeByKey(s, 'commitments:1')).toEqual({ closed: false })
  expect(await closeByKey(s, 'errands:abc')).toEqual({ closed: false })
  expect(await closeByKey(s, 'errands:99')).toEqual({ closed: false })
  expect(rows.map((r) => r.state)).toEqual(['open', 'open'])
  expect(await closeByKey(s, 'errands:1')).toEqual({ closed: true })
  expect(rows.map((r) => r.state)).toEqual(['done', 'open'])
  // Already done: nothing to close.
  expect(await closeByKey(s, 'errands:1')).toEqual({ closed: false })
})

test('day_docs_and_key_helpers', () => {
  expect(day('2026-02-30')).toBeUndefined()
  expect(day('next week')).toBeUndefined()
  expect(day(' 2026-09-10 ')).toBe('2026-09-10')
  expect(docsOf('["a"," ",3]')).toEqual(['a', '3'])
  expect(docsOf('not json')).toEqual([])
  expect(rowidOf('errands:12')).toBe(12)
  expect(rowidOf('errands:12x')).toBeUndefined()
})
