// SPDX-License-Identifier: AGPL-3.0-only
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { createTasks } from '../tools.js'
import { memoryStore } from './store.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..')

test('tasks_add_capability_shape', async () => {
  process.env.ALEXIA_PLUGIN_DIR = dir
  const { default: alexia } = await import('../index.js')
  const tool = alexia.server._registeredTools.tasks_add
  expect(tool._meta['alexia/provides']).toEqual(['tasks.add'])
  // Not read-only, not destructive: the proposed silent list.
  expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
  expect(alexia.manifest.provides).toEqual(expect.arrayContaining(['tasks.add', 'notice.items', 'notice.done', 'brief.section']))
  // `{text, due?, list?}` returns `{id}`.
  const tasks = createTasks({ storage: memoryStore(), capability: async () => undefined, now: () => 1 })
  const result = await tasks.add({ text: 'Buy milk', due: '2026-12-01', list: 'shopping' })
  expect(result.structuredContent).toEqual({ id: '1' })
})

test('notice_done_own_keys_only', async () => {
  const storage = memoryStore()
  storage.rows.push({ rowid: 1, text: 'A', state: 'open', list: 'tasks' }, { rowid: 2, text: 'B', state: 'open', list: 'tasks' })
  const tasks = createTasks({ storage, capability: async () => undefined, now: () => 5 })
  for (const key of ['commitments:1', 'tasks:', 'tasks:x', 'tasks:1x', 'planner:prep:1', '']) {
    expect((await tasks.noticeDone({ key })).structuredContent).toEqual({ closed: false })
  }
  expect(storage.rows.map((r) => r.state)).toEqual(['open', 'open'])
  expect((await tasks.noticeDone({ key: 'tasks:1' })).structuredContent).toEqual({ closed: true })
  expect(storage.rows.map((r) => r.state)).toEqual(['done', 'open'])
  // Already done, and a row that does not exist: nothing to close.
  expect((await tasks.noticeDone({ key: 'tasks:1' })).structuredContent).toEqual({ closed: false })
  expect((await tasks.noticeDone({ key: 'tasks:9' })).structuredContent).toEqual({ closed: false })
})
