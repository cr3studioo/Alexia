// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { noPolling } from './staged.js'
import type { Model } from '../src/catalog.js'
import { remaining, underHalf } from '../src/pool.js'
import { keyOf, type Provider } from '../src/provider.js'
import { MODES, route, type Pins, type World } from '../src/router.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'
import { Store } from '../src/store.js'

/**
 * `model_plan.md` §4 F's acceptance: **free limits per account, with the chat first** (D160, D161).
 *
 * OpenRouter's fifty free requests a day are shared by every free model on the account, so a
 * Telegram task in the afternoon could leave nothing for the chat in the evening. Background work
 * uses providers with no daily ration first, a day-limited one only when nothing else can do the
 * job, and then only the first half of its day.
 */

const kilo: Provider = { id: 'kilo-gateway', name: 'Kilo Gateway', baseUrl: 'http://127.0.0.1:9/v1', auth: 'optional', rpm: 200 }
const openrouter: Provider = { id: 'openrouter', name: 'OpenRouter', baseUrl: 'http://127.0.0.1:9/v1', rpm: 20, rpd: 50 }

const model = (id: string, provider: string, over: Partial<Model> = {}): Model => ({
  id,
  name: id,
  provider,
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
const onKey = model('vendor/strong-120b', 'openrouter', { weekly: 9_000 })
const onFloor = model('vendor/strong-120b', 'kilo-gateway')
const talker = model('vendor/talker', 'kilo-gateway', { supportsTools: false })

const noon = Date.UTC(2026, 8, 17, 12)
const pins = (over: Partial<Pins> = {}): Pins => ({ placement: MODES.combined, ...over })
const task = { messages: [{ role: 'user' as const, content: 'tidy my downloads' }], tools: [{ name: 'fs.list' }] }

/** A ledger with `used` of OpenRouter's fifty already spent today. */
const spentToday = (used: number): Store => {
  const store = new Store(':memory:')
  for (let i = 0; i < used; i++) store.recordRequest('openrouter', noon - i * 1000)
  return store
}
const world = (store: Store, models: Model[]): World => ({
  models,
  local: [],
  rungs: [{ ...remaining(store, openrouter, noon), keyed: true }, { ...remaining(store, kilo, noon), keyed: false }],
  today: { spent: 0, allowance: 0 },
})
const where = (verdict: ReturnType<typeof route>): string[] =>
  verdict.ok ? verdict.choices.map((c) => `${c.model.id}@${c.provider.id}`) : [verdict.why]

test('a background task goes to the provider with no daily ration, though the chat would ask the key first', () => {
  const store = spentToday(0)
  const both = world(store, [onKey, onFloor])
  // The chat: your key first, as the ladder says.
  expect(where(route(task, pins(), both))).toEqual(['vendor/strong-120b@openrouter', 'vendor/strong-120b@kilo-gateway'])
  // A message from a phone: Kilo, which rations by the minute and not the day.
  expect(where(route({ ...task, background: true }, pins(), both))).toEqual(['vendor/strong-120b@kilo-gateway'])
  store.close()
})

test('with only a day-limited provider able, background has the first half of its day and the chat the rest', () => {
  // Kilo's only model cannot use tools, so OpenRouter is the only thing that can do this.
  const at24 = spentToday(24)
  expect(where(route({ ...task, background: true }, pins(), world(at24, [onKey, talker])))).toEqual(['vendor/strong-120b@openrouter'])

  const at25 = spentToday(25)
  expect(underHalf(remaining(at25, openrouter, noon))).toBe(false)
  expect(where(route({ ...task, background: true }, pins(), world(at25, [onKey, talker])))).toEqual([
    "the rest of today's OpenRouter requests are kept for your chat",
  ])
  // A pin and a list are held to the same half.
  expect(where(route({ ...task, background: true }, pins({ model: 'vendor/strong-120b' }), world(at25, [onKey, talker])))).toEqual([
    "the rest of today's OpenRouter requests are kept for your chat",
  ])
  expect(
    where(route({ ...task, background: true }, pins({ order: ['vendor/strong-120b'] }), world(at25, [onKey, talker]))),
  ).toEqual(["the rest of today's OpenRouter requests are kept for your chat"])

  // The chat at 49 of 50 still asks OpenRouter.
  const at49 = spentToday(49)
  expect(where(route(task, pins(), world(at49, [onKey, talker])))).toEqual(['vendor/strong-120b@openrouter'])
  for (const one of [at24, at25, at49]) one.close()
})

// ---- Adapt counts as the chat -------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'alexia-chatfirst-'))
const from = mkdtempSync(join(tmpdir(), 'alexia-chatfirst-plugin-'))
const models: Server = createServer((request, response) => {
  request.resume()
  request.on('end', () => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'written' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
})
await new Promise<void>((resolve) => models.listen(0, '127.0.0.1', resolve))
const limited: Provider = { ...openrouter, baseUrl: `http://127.0.0.1:${String((models.address() as AddressInfo).port)}/v1` }
noPolling(root, [{ ...onKey }])
mkdirSync(join(from, 'asker'), { recursive: true })
writeFileSync(
  join(from, 'asker', 'plugin.json'),
  JSON.stringify({
    manifest_version: 1,
    id: 'asker',
    name: 'Asker',
    summary: 'Asks for a completion when a button is pressed, the way Adapt does.',
    version: '0.1.0',
    license: 'AGPL-3.0-only',
    entry: { run: 'node', args: [join(import.meta.dirname, 'fixtures', 'asker.js')] },
    alexia_protocol: 2,
    mcp_protocol: '2025-11-25',
    provides: ['ask.confirm'],
    settings: [{ type: 'action', key: 'plain', label: 'Just ask', tool: 'plain' }],
  }),
)
const secrets = memorySecrets()
await secrets.set(CORE, keyOf(limited), 'sk-or')
const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: from,
  secrets,
  providers: [limited],
  local: false,
})
afterAll(async () => {
  await alexia.close()
  models.close()
  for (const path of [root, from]) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('a request a plugin makes while its own button press is in flight is the chat, not background', async () => {
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
    (await (
      await fetch(new URL(path, alexia.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
        body: JSON.stringify(body),
      })
    ).json()) as Record<string, unknown>
  expect((await post('/api/plugin', { id: 'asker', action: 'enable' })).ok).toBe(true)
  // Forty-nine of the fifty spent: background would be refused long before this, Adapt is not.
  for (let i = 0; i < 49; i++) alexia.store.recordRequest('openrouter')
  const pressed = await post('/api/action', { plugin: 'asker', key: 'plain', approved: true })
  expect(String(pressed.said)).toContain('written')
}, 30_000)
