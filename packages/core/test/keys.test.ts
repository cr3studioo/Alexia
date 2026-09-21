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

/** The Models table's rows as `group: model@provider`, which is what a person reads off it (D161). */
const table = async (): Promise<string[]> =>
  (await rows('models')).map((row) => {
    const [provider, model] = String(row.id).split('\n')
    return `${String(row.group)}: ${String(model)}@${String(provider)}`
  })

test('saving a key waits for its list and says what it unlocked, and the Models tab has it at once', async () => {
  expect(await table()).toEqual(['Automatic, free: floor/one@floor'])

  // A key its provider will not list for: saved, and said plainly that the list did not come.
  const wrong = await post('/api/setup', { provider: { id: 'stub', key: 'sk-wrong' } })
  expect(String(wrong.said)).toContain('did not arrive')
  expect(String(wrong.said)).toContain('401')

  const right = await post('/api/setup', { provider: { id: 'stub', key: 'sk-stub' } })
  expect(right.said).toBe('Stub connected — 2 free models and 1 paid.')
  // No reopen, no wait: the answer came after the list, so the next read has it.
  expect((await table()).sort()).toEqual([
    'Automatic, free: floor/one@floor',
    'Automatic, free: stub/free-a@stub',
    'Automatic, free: stub/free-b@stub',
    'Paid: stub/paid@stub',
  ])

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
  expect(await table()).toEqual([
    'Your choice: stub/free-b@stub',
    'Your list: floor/one@floor',
    'Your list: stub/free-a@stub',
    'Automatic, free: floor/one@floor',
  ])
  const shown = await rows('models')
  expect(shown[0]).toMatchObject({ state: '◆ everything goes here · not available — no key for Stub', note: 'Your choice, not available — no key for Stub.' })
  // The list asks what it can, and says which entry it cannot, under the number it was given.
  expect(shown[1]?.note).toBe('Number 2 in your list, on Floor with no key.')
  expect(shown[2]?.note).toBe('Number 1 in your list, not available — no key for Stub.')

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
  expect(await table()).toContain('Your list: floor/one@floor')

  // With the shared floor switched off it does not still answer, and the sentence does not say so.
  expect((await post('/api/action', { key: 'set_keyless', row: 'off' })).ok).toBe(true)
  await secrets.set(CORE, keyOf(floor), 'sk-floor')
  expect(String((await post('/api/setup', { provider: { id: 'floor', remove: true } })).said)).not.toContain('still answers')
  expect((await post('/api/action', { key: 'set_keyless', row: 'on' })).ok).toBe(true)
}, 30_000)

/**
 * `model_plan.md` §1 step 2's last open piece: **the keyless group's switch** (D154).
 *
 * The floor is on by default, because hiding it would hide the only thing a fresh install has.
 * Off, its models leave `available()` — and so the Models tab, which reads the same function —
 * and the switch puts them back without a reload. A provider somebody pasted a key into is
 * keyed rather than the floor, so it is untouched either way.
 */
test('the keyless group switches off, marking its models unreachable, and back on again', async () => {
  /** What the ladder says about the floor's model: empty while it can be asked (`surface.ts`). */
  const reach = async (): Promise<string> =>
    String((await rows('routing')).find((one) => String(one.id) === 'floor/one')?.off ?? 'no such row')
  /** Floor rows Automatic would actually walk. */
  const automatic = async (): Promise<string[]> =>
    (await table()).filter((one) => one.startsWith('Automatic, free:') && one.endsWith('@floor'))

  expect(await reach()).toBe('')

  const off = await post('/api/action', { plugin: '', key: 'set_keyless', row: 'off' })
  expect(off.ok).toBe(true)
  expect(String(off.said)).toContain('Only providers you added a key for are asked')
  // Exactly what removing a key does (D163): out of every plan, and a listed entry kept but
  // marked — nothing the person chose is deleted by a switch that one press puts back.
  expect(await reach()).toBe('not available — no key for Floor')
  expect(await automatic()).toEqual([])

  const on = await post('/api/action', { plugin: '', key: 'set_keyless', row: 'on' })
  expect(on.ok).toBe(true)
  // It says how much came back, because the table behind the switch may not be on screen.
  expect(String(on.said)).toMatch(/^On\. \d+ models? from \d+ providers? that need no key are back\.$/)
  expect(await reach()).toBe('')
}, 30_000)
