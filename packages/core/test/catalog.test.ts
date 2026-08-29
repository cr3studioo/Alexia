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

test('each provider has its own clock, so the second list asked for in a day is fetched', async () => {
  const path = file()
  const catalog = new Catalog(path)
  const other: Provider = { ...provider, id: 'other', name: 'Other' }

  payload = { data: [entry()] }
  expect((await catalog.refresh(provider)).added).toHaveLength(1)

  // The bug this replaced: one `fetchedAt` for the whole file meant the first fetch of the
  // day told every other provider it was already fresh. Nobody noticed while one provider
  // was polled; a screen offering a choice between them is nothing but noticing.
  payload = { data: [entry({ id: 'other/model' })] }
  expect((await catalog.refresh(other)).added.map((m) => m.id)).toEqual(['other/model'])
  expect(catalog.models).toHaveLength(2)

  // And each still declines its own second fetch inside the day.
  expect((await catalog.refresh(provider)).added).toHaveLength(0)
  expect(catalog.fetchedFrom('other')).toBeGreaterThan(0)
  expect(catalog.fetchedFrom('never-asked')).toBe(0)
})

test('a cache from before the per-provider clock is honoured rather than re-fetched', async () => {
  const path = file()
  payload = { data: [entry()] }
  await new Catalog(path).refresh(provider)

  // Rewritten in the old shape: one timestamp, no map. Every provider reads it, so upgrading
  // does not fetch seven lists on the first launch.
  const { writeFileSync, readFileSync } = await import('node:fs')
  const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  delete snapshot.at
  writeFileSync(path, JSON.stringify(snapshot))

  const upgraded = new Catalog(path)
  expect(upgraded.fetchedFrom('anything-at-all')).toBe(upgraded.fetchedAt)
  expect((await upgraded.refresh({ ...provider, id: 'other' })).added).toHaveLength(0)
})

test('a provider that publishes nothing but ids is still a list of models', async () => {
  const path = file()
  const catalog = new Catalog(path)
  // Groq's shape, and roughly everyone's who is not OpenRouter: no pricing, no modalities,
  // no capability list, and the context window under its own name. It used to arrive as a
  // model with a context of zero, which sorts as unusable.
  payload = { data: [{ id: 'llama-3.3-70b', object: 'model', owned_by: 'Meta', context_window: 131_072 }] }
  await catalog.refresh(provider, 0)

  const [model] = catalog.models
  expect(model?.id).toBe('llama-3.3-70b')
  expect(model?.context).toBe(131_072)
  // Free, because nobody published a price and every one of these is a free tier. Not a
  // guess about tools, though: unstated is false, and the Models tab is how somebody
  // overrides that by hand.
  expect(model?.tier).toBe('T1')
  expect(model?.supportsTools).toBe(false)
})

test('a list that needs a key is fetched with one', async () => {
  const path = file()
  let seen: string | undefined
  const guarded = createServer((request, response) => {
    seen = request.headers.authorization
    // Groq, Cerebras and Mistral all answer this to a bare request. Four of the six do.
    if (seen === undefined) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'Invalid API Key' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'needs-a-key', context_window: 8_192 }] }))
  })
  await new Promise<void>((resolve) => guarded.listen(0, '127.0.0.1', resolve))
  const needy: Provider = { ...provider, id: 'needy', baseUrl: `http://127.0.0.1:${(guarded.address() as AddressInfo).port}` }

  const catalog = new Catalog(path)
  // Without one it is a failed fetch, not a provider with no models.
  expect((await catalog.refresh(needy, 0)).failed).toContain('could not reach')
  expect(catalog.models).toHaveLength(0)

  expect((await catalog.refresh(needy, 0, 'sk-users-own')).added.map((m) => m.id)).toEqual(['needs-a-key'])
  expect(seen).toBe('Bearer sk-users-own')
  guarded.close()
})

test('how much the world uses a model, joined to the list by the name both feeds use', async () => {
  const path = file()
  // The usage feed, in the shape openrouter.ai's own models page reads: keyed by permaslug,
  // with prompt and completion tokens counted separately.
  const feed = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        data: {
          analytics: {
            'qwen/qwen3-8b-20260101': { total_prompt_tokens: 900, total_completion_tokens: 100 },
            'someone/never-listed': { total_prompt_tokens: 5, total_completion_tokens: 5 },
            // A row that makes no sense is skipped rather than fatal, like everything here.
            'broken/row': { total_prompt_tokens: 'lots' },
          },
        },
      }),
    )
  })
  await new Promise<void>((resolve) => feed.listen(0, '127.0.0.1', resolve))
  const watched: Provider = { ...provider, usage: `http://127.0.0.1:${(feed.address() as AddressInfo).port}/` }

  // `canonical_slug` on the public list is `permaslug` on the usage feed. The public `id` is
  // not usable as a key: it drops the dated suffix and can carry a `:free` variant.
  payload = { data: [entry({ id: 'qwen/qwen3-8b:free', canonical_slug: 'qwen/qwen3-8b-20260101' })] }
  const catalog = new Catalog(path)
  await catalog.refresh(watched, 0)
  expect(catalog.models[0]?.weekly).toBe(1000)

  // A provider that publishes nothing leaves it absent rather than zero — zero sorts as
  // unused and reads as bad, and neither is what silence means.
  payload = { data: [entry({ id: 'plain/model', canonical_slug: 'plain/model-1' })] }
  await catalog.refresh({ ...provider, id: 'quiet' }, 0)
  expect(catalog.models.find((m) => m.provider === 'quiet')?.weekly).toBeUndefined()

  feed.close()
})

test('a usage feed that is gone takes nothing with it', async () => {
  const path = file()
  payload = { data: [entry()] }
  const catalog = new Catalog(path)
  // Nothing is listening on port 1, which is the endpoint being withdrawn or the machine
  // being offline. It reads an API nobody promised us, so the list has to survive it.
  const change = await catalog.refresh({ ...provider, usage: 'http://127.0.0.1:1/' }, 0)
  expect(change.failed).toBeUndefined()
  expect(catalog.models).toHaveLength(1)
  expect(catalog.models[0]?.weekly).toBeUndefined()
})

test('a cache written by an older parser is stale however fresh its timestamp is', async () => {
  const path = file()
  payload = { data: [entry()] }
  await new Catalog(path).refresh(provider)

  // Exactly the situation the day a field is added: a snapshot written minutes ago, by a
  // reader that did not know about `weekly`. Left alone, the per-provider clock honours it
  // for a day — or forever on a machine that is rarely open long enough to poll.
  const { writeFileSync, readFileSync } = await import('node:fs')
  const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  delete snapshot.parsedBy
  writeFileSync(path, JSON.stringify(snapshot))

  const upgraded = new Catalog(path)
  // The rows survive, so the screen is not empty while the new list is on its way.
  expect(upgraded.models).toHaveLength(1)
  expect(upgraded.fetchedFrom(provider.id)).toBe(0)
  payload = { data: [entry({ id: 'qwen/qwen3-30b:free' })] }
  expect((await upgraded.refresh(provider)).added.map((m) => m.id)).toEqual(['qwen/qwen3-30b:free'])
})
