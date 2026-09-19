// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, expect, test } from 'vitest'
import { noPolling } from './staged.js'
import { keyOf, type Provider } from '../src/provider.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'
import { caps, setCaps } from '../src/usage.js'

/**
 * **M8-1 and G13 over the wire**: a plugin's two declarations reaching the router, and a
 * button somebody pressed spending like the run it is (D156).
 *
 * `writer.test.ts` holds the rules. What only this reaches is the journey — `min_tier` off a
 * real manifest, `modelPreferences` off a real `sampling/createMessage`, and `pressing` —
 * because every one of those was a field or a map that existed and was never read on this
 * path. The plugin is `fixtures/writer.js`, which asks the way `plugins/persona` asks.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-writer-'))
const from = mkdtempSync(join(tmpdir(), 'alexia-writer-plugin-'))

/** Which model each request went to, in order. */
const asked: string[] = []
const models: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const { model } = JSON.parse(raw) as { model: string }
    asked.push(model)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'written' }, finish_reason: 'stop' }] })}\n\n` +
        `data: ${JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 100 } })}\n\ndata: [DONE]\n\n`,
    )
  })
})
await new Promise<void>((resolve) => models.listen(0, '127.0.0.1', resolve))

const stub: Provider = {
  id: 'stub',
  name: 'Stub',
  baseUrl: `http://127.0.0.1:${String((models.address() as AddressInfo).port)}/v1`,
  rpm: 1000,
  rpd: 1000,
}
const row = (id: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name,
  provider: 'stub',
  tier: 'T1',
  priceIn: 0,
  priceOut: 0,
  context: 32_768,
  supportsTools: true,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'unknown',
  ...over,
})
/**
 * A router that would otherwise come first — it is the busiest row here — a free model, and a
 * paid one that reads four times what the free one can, so it is a step up rather than the
 * same answer for money.
 */
noPolling(root, [
  row('stub-auto/free', 'Stub Auto', { weekly: 90_000 }),
  row('free/one', 'Free One', { weekly: 9_000 }),
  row('paid/one', 'Paid One', { tier: 'T2', priceIn: 1, priceOut: 2, context: 128_000, weekly: 8_000 }),
])

mkdirSync(join(from, 'writer'), { recursive: true })
writeFileSync(
  join(from, 'writer', 'plugin.json'),
  JSON.stringify({
    manifest_version: 1,
    id: 'writer',
    name: 'Writer',
    summary: 'Asks for a model that can write, the way the personality adapter does.',
    version: '0.1.0',
    license: 'AGPL-3.0-only',
    entry: { run: 'node', args: [join(import.meta.dirname, 'fixtures', 'writer.js')] },
    alexia_protocol: 2,
    mcp_protocol: '2025-11-25',
    // A floor that changes nothing here — `local: false`, so there is no `T0` row to exclude.
    // It is on the fixture so that *the manifest was read* and *the floor did something* are
    // two separate facts, and the second is the `demanding` plugin below.
    min_tier: 'T1',
    settings: [
      { type: 'action', key: 'adapt', label: 'Adapt', tool: 'adapt' },
      { type: 'action', key: 'plainly', label: 'Just ask', tool: 'plainly' },
    ],
  }),
)

/**
 * The same script under a second manifest, declaring a floor nothing free can reach. Two
 * folders and one process' worth of code: what differs is the declaration, which is the
 * whole of what this proves.
 */
mkdirSync(join(from, 'demanding'), { recursive: true })
writeFileSync(
  join(from, 'demanding', 'plugin.json'),
  JSON.stringify({
    manifest_version: 1,
    id: 'demanding',
    name: 'Demanding',
    summary: 'Declares a floor that only a paid model reaches.',
    version: '0.1.0',
    license: 'AGPL-3.0-only',
    entry: { run: 'node', args: [join(import.meta.dirname, 'fixtures', 'writer.js')] },
    alexia_protocol: 2,
    mcp_protocol: '2025-11-25',
    min_tier: 'T2',
    settings: [{ type: 'action', key: 'plainly', label: 'Just ask', tool: 'plainly' }],
  }),
)

const secrets = memorySecrets()
await secrets.set(CORE, keyOf(stub), 'sk-stub')
const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: from,
  secrets,
  providers: [stub],
  local: false,
})

afterAll(async () => {
  await alexia.close()
  models.close()
  for (const path of [root, from]) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
  (await (
    await fetch(new URL(path, alexia.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
      body: JSON.stringify(body),
    })
  ).json()) as Record<string, unknown>

/** One press of a row's button, approved. Returns what the plugin said. */
const press = async (key: string, plugin = 'writer'): Promise<string> =>
  String((await post('/api/action', { plugin, key, approved: true })).said)

for (const id of ['writer', 'demanding']) expect((await post('/api/plugin', { id, action: 'enable' })).ok).toBe(true)

beforeEach(() => {
  asked.length = 0
  setCaps(alexia.store, { ...caps(alexia.store), cross: undefined, daily: undefined })
})

test('a press that asks for a capable model reaches the paid one, because a press is a run (G13)', async () => {
  // The paid switch on with a day's amount: the same two rails a task at the keyboard has.
  setCaps(alexia.store, { ...caps(alexia.store), cross: true, daily: 1 })
  expect(await press('adapt')).toContain('paid/one')
  // And the router was never asked, though it is the busiest row in this catalog.
  expect(asked).toEqual(['paid/one'])
  // The charge landed on a row that says which run and which plugin made it (M7-2).
  const spent = alexia.store.spendBy('plugin', 0)
  expect(spent).toEqual([{ key: 'writer', cost: expect.any(Number) }])
  expect(spent[0]?.cost).toBeGreaterThan(0)
}, 30_000)

test('the same press stays free when the paid switch is off: a run is not a licence to spend', async () => {
  // §4 H is unchanged by G13. Nobody turned the switch on, so the free side answers and the
  // capable preference only decides which free model that is.
  expect(await press('adapt')).toContain('free/one')
  expect(asked).toEqual(['free/one'])
}, 30_000)

test('a plugin that says nothing about the model gets the cheapest that fits, as it always did', async () => {
  setCaps(alexia.store, { ...caps(alexia.store), cross: true, daily: 1 })
  expect(await press('plainly')).toContain('free/one')
  // Cheapest-first, so the free model answers and the router is still ranked last.
  expect(asked).toEqual(['free/one'])
}, 30_000)

test('min_tier off the manifest is the floor, and it is what refuses when nothing reaches it', async () => {
  // The same script as the test above, saying nothing about `modelPreferences`. What sends it
  // to the paid model is its manifest — a field core read for the first time in M8-1.
  setCaps(alexia.store, { ...caps(alexia.store), cross: true, daily: 1 })
  expect(await press('plainly', 'demanding')).toContain('paid/one')
  expect(asked).toEqual(['paid/one'])

  // And with the switch off there is nothing at or above its floor that may answer, so it
  // stops with a sentence rather than quietly dropping to a free model it said it cannot use.
  asked.length = 0
  setCaps(alexia.store, { ...caps(alexia.store), cross: false, daily: undefined })
  expect(await press('plainly', 'demanding')).toContain('does not spend money on its own')
  expect(asked).toEqual([])
}, 30_000)
