// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { Catalog, news } from '../src/catalog.js'
import type { Provider } from '../src/provider.js'

// The catalog is a cache with a diff on it. What is worth testing is the unhappy half:
// the endpoint changing shape, and the machine being offline.

let payload: unknown = { data: [] }
let status = 200

const server: Server = createServer((_request, response) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
afterAll(() => void server.close())

const provider: Provider = {
  id: 'test',
  name: 'Test',
  baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  models: '/models',
  trainsOnYourData: 'yes',
}

const file = (): string => join(mkdtempSync(join(tmpdir(), 'alexia-catalog-')), 'cache', 'models.json')

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'qwen/qwen3-8b:free',
  name: 'Qwen3 8B (free)',
  context_length: 32_768,
  pricing: { prompt: '0', completion: '0' },
  architecture: { input_modalities: ['text'] },
  supported_parameters: ['tools', 'temperature'],
  top_provider: { is_moderated: true },
  ...over,
})

test('what the endpoint says, in the shape the router asks questions in', async () => {
  payload = {
    data: [
      entry(),
      entry({
        id: 'anthropic/claude-opus-5',
        name: 'Claude Opus 5',
        pricing: { prompt: '0.000005', completion: '0.000025' },
        supported_parameters: ['tools'],
        top_provider: {},
      }),
      entry({ id: 'meta/llama-3-8b', pricing: { prompt: '0.00000002', completion: '0.00000005' } }),
    ],
  }

  const catalog = new Catalog(file())
  const change = await catalog.refresh(provider)

  expect(change.failed).toBeUndefined()
  expect(catalog.models.map((m) => [m.id, m.tier])).toEqual([
    ['qwen/qwen3-8b:free', 'T1'], //          free is free
    ['anthropic/claude-opus-5', 'T3'], //     $5/Mtok in is frontier
    ['meta/llama-3-8b', 'T2'], //             two cents a million is small paid
  ])

  expect(catalog.models[0]).toMatchObject({
    provider: 'test',
    priceIn: 0,
    context: 32_768,
    supportsTools: true,
    modality: ['text'],
    nsfwOk: 'no', //                          a moderated endpoint refuses
    trainsOnYourData: 'yes', //               from the provider row, never from the price
  })
  // A provider that does not say is not assumed either way.
  expect(catalog.models[1]?.nsfwOk).toBe('unknown')
  expect(news(change)).toBe('1 new free model is available.')
})

test('a second fetch is news only about what is new', async () => {
  const catalog = new Catalog(file())
  payload = { data: [entry()] }
  await catalog.refresh(provider)

  payload = { data: [entry(), entry({ id: 'qwen/qwen3-30b:free' }), entry({ id: 'x/paid', pricing: { prompt: '0.000004', completion: '0.000004' } })] }
  // maxAge 0, because the cache is a second old and the daily poll would skip it.
  const change = await catalog.refresh(provider, 0)

  expect(change.added.map((m) => m.id)).toEqual(['qwen/qwen3-30b:free', 'x/paid'])
  expect(change.removed).toEqual([])
  expect(news(change)).toBe('1 new free model is available.')

  payload = { data: [entry()] }
  const shrunk = await catalog.refresh(provider, 0)
  expect(shrunk.removed.map((m) => m.id)).toEqual(['qwen/qwen3-30b:free', 'x/paid'])
  expect(news(shrunk)).toBeUndefined()
})

test('the cache is what makes it work offline, and a fresh one is not re-fetched', async () => {
  const path = file()
  payload = { data: [entry()] }
  await new Catalog(path).refresh(provider)

  // A new process, the same cache file. Nothing is fetched: the poll is daily.
  payload = { data: [entry(), entry({ id: 'qwen/qwen3-30b:free' })] }
  const restarted = new Catalog(path)
  expect(restarted.models.map((m) => m.id)).toEqual(['qwen/qwen3-8b:free'])
  expect(await restarted.refresh(provider)).toEqual({ added: [], removed: [] })
  expect(restarted.fetchedAt).toBeGreaterThan(0)

  // And with the provider unreachable, the cached list is still the list.
  const offline = { ...provider, baseUrl: 'http://127.0.0.1:1' }
  const change = await restarted.refresh(offline, 0)
  expect(change.failed).toContain('could not reach')
  expect(restarted.models.map((m) => m.id)).toEqual(['qwen/qwen3-8b:free'])
})

test('the day the endpoint changes shape is not the day this breaks', async () => {
  const path = file()
  payload = { data: [entry()] }
  await new Catalog(path).refresh(provider)

  const catalog = new Catalog(path)
  // An entry with no id is not a model. The rest of the list still is.
  payload = { data: [{ nonsense: true }, entry({ id: 'qwen/qwen3-30b:free', pricing: undefined })] }
  const change = await catalog.refresh(provider, 0)
  expect(change.added.map((m) => m.id)).toEqual(['qwen/qwen3-30b:free'])
  expect(catalog.models).toHaveLength(1)

  // Nothing usable at all reads as a shape change, not as a world with no models in it.
  payload = { data: 'surprise' }
  expect((await catalog.refresh(provider, 0)).failed).toContain('nothing usable')
  expect(catalog.models).toHaveLength(1)

  status = 500
  expect((await catalog.refresh(provider, 0)).failed).toContain('could not reach')
  expect(catalog.models).toHaveLength(1)
  status = 200
})
