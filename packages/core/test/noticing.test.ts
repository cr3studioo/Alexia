// SPDX-License-Identifier: AGPL-3.0-only
import { Manifest, MCP_PINNED, SETTINGS_CHANGED } from '@alexia/protocol'
import type { CreateMessageResult } from '@modelcontextprotocol/client'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { Host } from '../src/host.js'
import { memorySecrets } from '../src/secrets.js'
import { PluginProcess } from '../src/supervisor.js'
import { Store } from '../src/store.js'

/**
 * M7-3's acceptance, end to end: **say something, never call `remember`, wait one pass, and
 * find it written down and linked from the right place.**
 *
 * A real plugin process, real storage over the real `alexia/*` layer, and a scripted model
 * where a free one would be — which is the only stub, and it is the one thing this machine
 * cannot supply on demand. Everything else is the code that ships.
 *
 * The test names the plugin because a test is allowed to; invariant 1 reads `packages/core`
 * and `packages/ui`, which is where naming one would matter.
 */

const dir = join(import.meta.dirname, '..', '..', '..', 'plugins', 'memory')
const manifest = Manifest.parse(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')))
const root = mkdtempSync(join(tmpdir(), 'alexia-noticing-'))
const store = new Store(join(root, 'alexia.db'))

/** What the scripted model says next. One string, replaced per test. */
let says = '[]'
const asked: string[] = []
const logs: string[] = []

const host = new Host({
  store,
  dataDir: root,
  secrets: memorySecrets(),
  manifest: (id) => (id === manifest.id ? manifest : undefined),
  // Kept rather than printed: a plugin that dies says why here, and the failure message
  // is otherwise `Connection closed`, which says nothing at all.
  log: (_id, line) => logs.push(line),
  sample: (_id, params) => {
    asked.push(params.messages.map((turn) => ([turn.content].flat().map((b) => (b.type === 'text' ? b.text : '')).join(''))).join('\n'))
    return Promise.resolve({ model: 'stub', role: 'assistant', content: { type: 'text', text: says } } as CreateMessageResult)
  },
})

// What enabling a plugin does: its namespace exists before its process does (M2-5).
store.create(manifest.id, manifest.storage?.tables ?? [])

const plugin = new PluginProcess(manifest, dir, host)
afterAll(async () => {
  await plugin.stop()
  store.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const rows = (table: string): Record<string, unknown>[] => store.select('memory', table, { order: [['at', 'asc']] })
const facts = (): Record<string, unknown>[] => rows('facts')
const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const result = await plugin.callTool(name, args)
  return (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('')
}

/** MCP's pinned revision, so a change to it turns this red rather than the whole file grey. */
test('the plugin core is driving here is the one that ships', async () => {
  expect(manifest.mcp_protocol).toBe(MCP_PINNED)
  // A timer needs a process, and lazy spawn cannot hold one (D77).
  expect(manifest.lifetime).toBe('resident')
  await plugin.listTools()
  // It boots clean, and if it does not the reason is here rather than in `Connection closed`.
  expect(logs.filter((line) => !line.startsWith('[info]')).join(' · ')).toBe('')
})

test('with the switch off, nothing is bound and core has nothing to hand it to', async () => {
  // The consent, and it lives in the binding rather than in a check inside the plugin: with
  // capture off, `capability()` resolves nothing and core never sends the exchange at all.
  // A folder appearing is not consent (D73), and neither is a plugin being enabled.
  const bound = (await plugin.listTools()).find((tool) => tool.name === 'capture')
  expect(bound, 'the tool exists either way — it is the binding that waits').toBeDefined()
  expect(bound?._meta?.['alexia/provides']).toEqual([])
})

test('a thing said in passing is written down without anybody calling remember', async () => {
  store.setSetting('memory', 'capture', true)
  store.setSetting('memory', 'interval', 1)
  // Core tells the plugin its settings changed, the same notification the settings screen
  // sends. The binding follows it, which is the whole of how the switch works.
  await plugin.notify(SETTINGS_CHANGED, { changed: { capture: true, interval: 1 } })
  await expect
    .poll(async () => (await plugin.listTools()).find((tool) => tool.name === 'capture')?._meta?.['alexia/provides'])
    .toEqual(['memory.capture'])

  // Somebody says something worth keeping, in the middle of asking for something else.
  await call('capture', {
    said: 'sort my downloads — I am doing a PhD at CTU FEL and the grant application is due in March',
    answered: 'Done, 31 files moved.',
    at: Date.now(),
  })
  expect(rows('buffer')).toHaveLength(1)
  // No model was called to store it. The bar for writing is on the floor on purpose: a fact
  // never written cannot be recalled, and a trivial one costs nothing to skip past later.
  expect(asked).toHaveLength(0)

  says = JSON.stringify([
    { name: 'the PhD', text: 'He is doing a PhD at CTU FEL.', kind: 'fact', links: [] },
    { name: 'the grant', text: 'His grant application is due in March.', kind: 'task', links: ['the PhD'] },
  ])
  // What the timer does, done once rather than waited for. `sort_now` is the same pass.
  expect(await call('sort_now')).toContain('2')

  const written = facts()
  expect(written.map((row) => row.text)).toEqual([
    'He is doing a PhD at CTU FEL.',
    'His grant application is due in March.',
  ])
  // Nobody said either sentence, so recall will say so when it reads them back.
  expect(written.every((row) => row.source === 'inferred')).toBe(true)

  // Linked from the right place, and **both ways**: the grant hangs off the PhD, and the PhD
  // knows the grant hangs off it. That is what lets one note sit under two parents later.
  expect(JSON.parse(String(written[1]?.links))).toEqual(['the PhD'])
  expect(JSON.parse(String(written[0]?.links))).toEqual(['the grant'])

  // The buffer drained, so the next pass on an idle Alexia asks nothing at all.
  expect(rows('buffer')).toHaveLength(0)
  expect(await call('sort_now')).toContain('nothing waiting')
  expect(asked).toHaveLength(1)
})

test('recall brings back the hit and what it hangs off, and says which it was told', async () => {
  const said = await call('recall', { about: 'grant deadline' })
  expect(said).toContain('His grant application is due in March.')
  // The linked parent came too, without the word "grant" appearing in it — which is exactly
  // what keyword ranking alone cannot do, and the reason the notes have names.
  expect(said).toContain('He is doing a PhD at CTU FEL.')
  expect(said).toContain('linked')
  expect(said).toContain('worked out rather than said')
})

test('forget that, and it does not come back on the next tick', async () => {
  // The failure this exists to prevent, in the predecessor owner's own words: *"if I say
  // forget something and in the buffer there is the same thing… that gets remembered in 12
  // minutes, it kinda loses the point."*
  await call('capture', { said: 'reminder: the grant application is due in March', answered: 'Noted.', at: Date.now() })
  expect(rows('buffer')).toHaveLength(1)

  expect(await call('forget', { about: 'grant application March' })).toContain('Forgotten')
  expect(facts().map((row) => row.text)).toEqual(['He is doing a PhD at CTU FEL.'])
  // The buffer went with it. Without this line the note is back in one pass.
  expect(rows('buffer')).toHaveLength(0)

  // And the link that pointed at it was mended, so nothing on screen refers to a note that
  // is not there any more.
  expect(JSON.parse(String(facts()[0]?.links))).toEqual([])

  says = '[]'
  await call('sort_now')
  expect(facts().map((row) => row.text)).toEqual(['He is doing a PhD at CTU FEL.'])
})

test('a forget that matched nothing is still written down as having been asked', async () => {
  // Losing memory quietly is the one unrecoverable failure this kind of system has, so the
  // tombstone is written whether or not anything matched. Nobody later has to wonder.
  await call('forget', { about: 'something never mentioned' })
  const stones = rows('forgotten')
  expect(stones.map((row) => row.about)).toContain('something never mentioned')
  expect(stones.find((row) => row.about === 'something never mentioned')?.matched).toBe(0)
  expect(stones.find((row) => String(row.about).includes('grant'))?.matched).toBe(1)
})

test('a batch the model cannot answer is set aside after three tries, never discarded', async () => {
  await call('capture', { said: 'something that breaks the call', answered: 'ok', at: Date.now() })
  // Prose rather than JSON: the model did not answer, which is not the same as *nothing
  // worth keeping*. Confusing the two is how an hour of conversation disappears.
  says = 'I had a look and there was not much in there really.'
  for (let i = 0; i < 3; i += 1) expect(await call('sort_now')).toContain('could not')

  const [stuck] = rows('buffer')
  expect(stuck?.tries).toBe(3)

  // Set aside, not deleted — the row is still there, and it no longer blocks the rest.
  says = JSON.stringify([{ name: 'the tea', text: 'He prefers tea.', kind: 'preference', links: [] }])
  await call('capture', { said: 'I prefer tea', answered: 'Noted.', at: Date.now() })
  await call('sort_now')
  expect(facts().map((row) => row.text)).toContain('He prefers tea.')
  expect(rows('buffer')).toHaveLength(1)
})

test('emptying it empties the buffer too, and everything lives in the namespace', async () => {
  await call('capture', { said: 'one more thing', answered: 'ok', at: Date.now() })
  await call('forget_all')
  expect(facts()).toHaveLength(0)
  expect(rows('buffer')).toHaveLength(0)

  // Invariant 5's precondition, for the two tables M7-3 added: everything this plugin wrote
  // is inside the namespace a purge drops, so deleting the folder still takes all of it.
  const mine = store.tables().filter((name) => name.startsWith('p_memory_'))
  expect(mine.sort()).toEqual(['p_memory_buffer', 'p_memory_facts', 'p_memory_forgotten'])
  store.purge('memory')
  expect(store.tables().filter((name) => name.startsWith('p_memory_'))).toEqual([])
})
