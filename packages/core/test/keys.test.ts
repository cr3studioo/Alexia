// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { noPolling } from './staged.js'
import { keyOf, type Provider } from '../src/provider.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'

/**
 * `model_plan.md` §1 steps 3–4: **the list follows the keychain.**
 *
 * Saving a key used to fire off a fetch of that provider's list and answer before it landed,
 * so the Models tab opened straight after showed the provider with nothing in it; and there
 * was no way to take a key out again. Now a save waits for the list and says what it
 * unlocked, a removal takes the key out of the keychain, and a pin or a list that named the
 * provider's models keeps them, shown as not available.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-keys-'))

/** A provider that lists its models only to the right key. */
const models: Server = createServer((request, response) => {
  if (request.url !== '/v1/models') {
    response.writeHead(404)
    response.end()
    return
  }
  if (request.headers.authorization !== 'Bearer sk-stub') {
    response.writeHead(401, { 'content-type': 'text/plain' })
    response.end('invalid key')
    return
  }
  const free = { prompt: '0', completion: '0' }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify({
      data: [
        { id: 'stub/free-a', name: 'Free A', pricing: free, context_length: 32_768, supported_parameters: ['tools'] },
        { id: 'stub/free-b', name: 'Free B', pricing: free, context_length: 32_768, supported_parameters: ['tools'] },
        { id: 'stub/paid', name: 'Paid', pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 128_000 },
      ],
    }),
  )
})
await new Promise<void>((resolve) => models.listen(0, '127.0.0.1', resolve))

const stub: Provider = {
  id: 'stub',
  name: 'Stub',
  baseUrl: `http://127.0.0.1:${(models.address() as AddressInfo).port}/v1`,
  models: '/models',
  pricing: 'published',
  rpm: 1000,
  rpd: 1000,
}
/** A keyless provider, cached already, so a fresh install has something to list. */
const floor: Provider = { id: 'floor', name: 'Floor', baseUrl: 'http://127.0.0.1:9/v1', auth: 'optional', rpm: 1000, rpd: 1000 }

noPolling(root, [
  {
    id: 'floor/one',
    name: 'Floor One',
    provider: 'floor',
    tier: 'T1',
    priceIn: 0,
    priceOut: 0,
    context: 32_768,
    supportsTools: true,
    modality: ['text'],
    nsfwOk: 'unknown',
    trainsOnYourData: 'unknown',
  },
])

const secrets = memorySecrets()
const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: join(root, 'extensions'),
  secrets,
  providers: [stub, floor],
  local: false,
})

afterAll(async () => {
  await alexia.close()
  models.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
  (await (
    await fetch(new URL(path, alexia.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
      body: JSON.stringify(body),
    })
  ).json()) as Record<string, unknown>

const rows = async (key: string): Promise<Record<string, string>[]> =>
  ((await post('/api/rows', { key })).rows ?? []) as Record<string, string>[]

test('saving a key waits for its list and says what it unlocked, and the Models tab has it at once', async () => {
  expect((await rows('models')).map((row) => row.id)).toEqual(['floor/one'])

  // A key its provider will not list for: saved, and said plainly that the list did not come.
  const wrong = await post('/api/setup', { provider: { id: 'stub', key: 'sk-wrong' } })
  expect(String(wrong.said)).toContain('did not arrive')
  expect(String(wrong.said)).toContain('401')

  const right = await post('/api/setup', { provider: { id: 'stub', key: 'sk-stub' } })
  expect(right.said).toBe('Stub connected — 2 free models and 1 paid.')
  // No reopen, no wait: the answer came after the list, so the next read has it.
  expect((await rows('models')).map((row) => row.id).sort()).toEqual(['floor/one', 'stub/free-a', 'stub/free-b', 'stub/paid'])

  // On *free only* the count is what the slider lets answer, the same rule the tab reads.
  await post('/api/action', { key: 'set_spend', row: 'free' })
  expect((await post('/api/setup', { provider: { id: 'stub', key: 'sk-stub' } })).said).toBe('Stub connected — 2 free models.')
  await post('/api/action', { key: 'set_spend', row: 'mixed' })
}, 30_000)

test('removing a key takes it out of the keychain and the list, and a pin or a list keeps what it named', async () => {
  expect((await post('/api/action', { key: 'set_order', row: 'stub/free-a,floor/one' })).ok).toBe(true)
  expect((await post('/api/action', { key: 'use_model', row: 'stub/free-b' })).ok).toBe(true)

  const removed = await post('/api/setup', { provider: { id: 'stub', remove: true } })
  expect(removed.said).toBe(
    'The Stub key is removed, and its 3 models are no longer listed. The model you chose stays chosen and your list keeps the one it names, shown as not available until a key is back.',
  )
  expect(await secrets.get(CORE, keyOf(stub))).toBeUndefined()

  // The tab changes back without a reload — except the pinned row, which says why it is there.
  const table = await rows('models')
  expect(table.map((row) => row.id).sort()).toEqual(['floor/one', 'stub/free-b'])
  expect(table.find((row) => row.id === 'stub/free-b')?.state).toBe('◆ everything goes here · not available — no key for Stub')

  // Nothing the person wrote was edited: the list still names both, in order.
  const state = (await (await fetch(new URL('/api/state', alexia.url), { headers: { 'x-alexia-token': alexia.token } })).json()) as {
    pins: { order?: string[]; model?: string }
  }
  expect(state.pins.order).toEqual(['stub/free-a', 'floor/one'])
  expect(state.pins.model).toBe('stub/free-b')
  // And the ladder is given the listed row, marked, so a drag does not save it away.
  const ladder = await rows('routing')
  expect(ladder.find((row) => row.id === 'stub/free-a')).toMatchObject({ rank: '1', off: 'not available — no key for Stub' })
  expect(ladder.find((row) => row.id === 'floor/one')).toMatchObject({ rank: '2', off: '' })
  // A model nobody named stays out of the ladder, as it always did.
  expect(ladder.map((row) => row.id)).not.toContain('stub/paid')

  // A key back, and everything is available again with nothing to restore.
  await post('/api/setup', { provider: { id: 'stub', key: 'sk-stub' } })
  expect((await rows('routing')).find((row) => row.id === 'stub/free-a')?.off).toBe('')
}, 30_000)

test('removing the key of a provider that answers without one leaves it on the shared floor', async () => {
  await secrets.set(CORE, keyOf(floor), 'sk-floor')
  expect((await post('/api/setup', { provider: { id: 'floor', remove: true } })).said).toBe(
    'The Floor key is removed. Floor still answers without one, on its shared free tier.',
  )
  expect((await rows('models')).map((row) => row.id)).toContain('floor/one')
}, 30_000)
