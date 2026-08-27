// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import { Plugins } from '../src/plugins.js'
import { Store } from '../src/store.js'
import { stage } from './staged.js'

// M0-7: two plugins, one requiring what the other provides — and what happens to the
// consumer when the provider is deleted. The consumer keeps running and explains itself,
// in its author's words, because a plugin that silently vanished would be
// indistinguishable from one that was never installed.

const dir = stage('hello', 'vanisher')
const store = new Store(':memory:')
const changed: string[] = []
const plugins = new Plugins({
  dir,
  store,
  dataDir: mkdtempSync(join(tmpdir(), 'alexia-data-')),
  onToolsChanged: (id) => changed.push(id),
})

afterAll(async () => {
  await plugins.stop()
  store.close()
})

const say = async (): Promise<string> => {
  const result = await plugins.process('vanisher')!.callTool('greet_via_alexia', { who: 'Vaclav' })
  return String((result.content[0] as { text?: string }).text)
}

test('two plugins, one calling what the other provides, by name only', async () => {
  plugins.load()
  plugins.watch()
  expect(plugins.ids).toEqual(['hello', 'vanisher'])
  expect(plugins.problems).toEqual([])
  expect(plugins.unmet('vanisher')).toEqual([])

  // Routed through core: vanisher asked for `demo.greet`, not for hello.
  expect(await say()).toBe('Hello, Vaclav.')
}, 30_000)

test('deleting the provider leaves the consumer running and explaining itself', async () => {
  const before = plugins.process('vanisher')?.pid
  rmSync(join(dir, 'hello'), { recursive: true })

  await vi.waitFor(() => expect(plugins.ids).toEqual(['vanisher']), { timeout: 10_000 })
  expect(changed).toContain('hello')

  // The author's sentence, which core never wrote and never rewrote.
  expect(await say()).toBe('Nothing installed can greet anyone right now.')
  expect(plugins.unmet('vanisher')).toEqual([
    { cap: 'demo.greet', why: 'to have something else do the greeting' },
  ])
  // And the same process throughout: nothing else noticed.
  expect(plugins.process('vanisher')?.pid).toBe(before)
}, 30_000)

test('a folder that is not a plugin is a problem, not a crash', async () => {
  mkdirSync(join(dir, 'rubbish'), { recursive: true })
  writeFileSync(join(dir, 'rubbish', 'plugin.json'), '{ "id": "rubbish" }')

  await vi.waitFor(() => expect(plugins.problems).toHaveLength(1), { timeout: 10_000 })
  expect(plugins.problems[0]?.reason).toContain('rubbish')
  // Everything else carried on regardless, which is the whole point of saying so.
  expect(plugins.ids).toEqual(['vanisher'])
}, 30_000)
