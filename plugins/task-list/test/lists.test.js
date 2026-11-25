// SPDX-License-Identifier: AGPL-3.0-only
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { createTasks } from '../tools.js'
import { day, newItem } from '../lists.js'
import { memoryStore } from './store.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
const NOW = Date.parse('2026-11-25T09:00:00Z')

test('add_and_done', async () => {
  const storage = memoryStore()
  const tasks = createTasks({ storage, capability: async () => { throw new Error('none') }, now: () => NOW })
  const added = await tasks.add({ text: 'Buy milk', list: ' Shopping ', due: '2026-11-26' })
  const id = added.structuredContent.id
  expect(storage.rows[0]).toMatchObject({ list: 'shopping', text: 'Buy milk', due: '2026-11-26', state: 'open', place: null, person: null, at: NOW })
  expect((await tasks.add({ text: 'Call bank' })).structuredContent.id).not.toBe(id)
  expect(storage.rows[1].list).toBe('tasks')
  expect((await tasks.tasks({})).structuredContent.items).toHaveLength(2)
  expect((await tasks.tasks({ list: 'shopping' })).structuredContent.items.map((i) => i.text)).toEqual(['Buy milk'])
  expect((await tasks.lists()).structuredContent.lists).toEqual([{ name: 'shopping', open: 1 }, { name: 'tasks', open: 1 }])

  const done = await tasks.done({ id })
  expect(done.isError).toBeUndefined()
  expect(storage.rows[0]).toMatchObject({ state: 'done', done_at: NOW })
  // The row is kept, not removed, and done is idempotent.
  expect(storage.rows).toHaveLength(2)
  expect((await tasks.done({ id })).content[0].text).toBe('That one is already done.')
  expect((await tasks.tasks({})).structuredContent.items).toHaveLength(1)
  expect((await tasks.tasks({ state: 'done' })).structuredContent.items.map((i) => i.text)).toEqual(['Buy milk'])
  expect((await tasks.tasks({ state: 'all' })).structuredContent.items).toHaveLength(2)
  expect((await tasks.done({ id: '99' })).isError).toBe(true)
  expect((await tasks.add({ text: '   ' })).isError).toBe(true)
})

test('no_delete_tool_exists', async () => {
  process.env.ALEXIA_PLUGIN_DIR = dir
  const { default: alexia } = await import('../index.js')
  const names = Object.keys(alexia.server._registeredTools)
  expect([...names].sort()).toEqual(['add_task', 'brief_section', 'done_task', 'lists', 'notice_done', 'notice_items', 'tasks', 'tasks_add'])
  expect(names.filter((n) => /delete|remove|forget|clear|drop|erase/.test(n))).toEqual([])
})

test('iso_days_only', async () => {
  expect(day('2026-11-30')).toBe('2026-11-30')
  for (const bad of ['tomorrow', 'pátek', '30.11.2026', '2026-13-01', '2026-02-30', '2026-11-3', '']) expect(day(bad)).toBeUndefined()
  expect(newItem({ text: 'x', due: 'tomorrow' }).error).toContain('YYYY-MM-DD')
  expect(newItem({ text: 'x', due: '2026-02-30' }).row).toBeUndefined()
  expect(newItem({ text: 'x' }).row.due).toBeNull()
  const storage = memoryStore()
  const tasks = createTasks({ storage, capability: async () => undefined, now: () => NOW })
  const refused = await tasks.add({ text: 'Pay rent', due: 'pátek' })
  expect(refused.isError).toBe(true)
  expect(storage.rows).toEqual([])
})
