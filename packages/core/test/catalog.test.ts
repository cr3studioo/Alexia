// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { borrow, Catalog, news, POLL_EVERY, routes, SEEDED, sizeOf, type Model } from '../src/catalog.js'
import { PROVIDERS, type Provider } from '../src/provider.js'

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
  expect(catalog.fetched.map((m) => [m.id, m.tier])).toEqual([
    ['qwen/qwen3-8b:free', 'T1'], //          free is free
    ['anthropic/claude-opus-5', 'T3'], //     $5/Mtok in is frontier
    ['meta/llama-3-8b', 'T2'], //             two cents a million is small paid
  ])

  expect(catalog.fetched[0]).toMatchObject({
    provider: 'test',
    priceIn: 0,
    context: 32_768,
    supportsTools: true,
    modality: ['text'],
    nsfwOk: 'no', //                          a moderated endpoint refuses
    trainsOnYourData: 'yes', //               from the provider row, never from the price
  })
  // A provider that does not say is not assumed either way.
  expect(catalog.fetched[1]?.nsfwOk).toBe('unknown')
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
  expect(restarted.fetched.map((m) => m.id)).toEqual(['qwen/qwen3-8b:free'])
  expect(await restarted.refresh(provider)).toEqual({ added: [], removed: [], listKnown: true })
  expect(restarted.fetchedAt).toBeGreaterThan(0)

  // And with the provider unreachable, the cached list is still the list.
  const offline = { ...provider, baseUrl: 'http://127.0.0.1:1' }
  const change = await restarted.refresh(offline, 0)
  expect(change.failed).toContain('could not reach')
  expect(restarted.fetched.map((m) => m.id)).toEqual(['qwen/qwen3-8b:free'])
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
  expect(catalog.fetched).toHaveLength(1)

  // Nothing usable at all reads as a shape change, not as a world with no models in it.
  payload = { data: 'surprise' }
  expect((await catalog.refresh(provider, 0)).failed).toContain('nothing usable')
  expect(catalog.fetched).toHaveLength(1)

  status = 500
  expect((await catalog.refresh(provider, 0)).failed).toContain('could not reach')
  expect(catalog.fetched).toHaveLength(1)
  status = 200
})

test('a price of minus one is not a price, and does not get to undercut the free tier', async () => {
  const path = file()
  // OpenRouter prices its own meta-routers at -1, meaning *varies, this picks for you*. Read
  // as a number that is minus a million per million tokens, which sorts below zero — so the
  // five of them beat all 104 genuinely free models to every automatic choice on the machine.
  payload = {
    data: [
      entry({ id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } }),
      entry({ id: 'openrouter/fusion', pricing: { prompt: '-1', completion: '0' } }),
      entry({ id: 'qwen/qwen3-30b:free' }),
    ],
  }
  const catalog = new Catalog(path)
  expect((await catalog.refresh(provider)).added.map((m) => m.id)).toEqual(['qwen/qwen3-30b:free'])
  expect(catalog.fetched.every((m) => m.priceIn >= 0 && m.priceOut >= 0)).toBe(true)
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
  expect(catalog.fetched).toHaveLength(2)

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

test('a price nobody published is not free, on a provider that prices what it sells (D154)', async () => {
  const path = file()
  const catalog = new Catalog(path)
  // Requesty's shape: prices per token under names of its own, a tier table where OpenRouter
  // keeps its two strings, and a tool flag rather than a parameter list. Read as before, all
  // 684 of its models arrived at zero — and zero is the free tier.
  payload = {
    data: [
      { id: 'sail/gpt-oss-120b', input_price: 6e-8, output_price: 4e-7, pricing: [{ input_price: 6e-8 }], supports_tool_calling: true, context_window: 131_072 },
      { id: 'nvidia/nemotron-3-super-120b-a12b', input_price: 0, output_price: 0, supports_tool_calling: true, context_window: 262_144 },
      // Navy's shape for a row it did not price: the field is there, and it says nothing.
      { id: 'schizogpt', pricing: null },
      { id: 'GLM-4.7-Flash' },
    ],
  }
  await catalog.refresh({ ...provider, pricing: 'published', freeModels: ['glm-4.7-flash'] }, 0)

  const by = new Map(catalog.fetched.map((m) => [m.id, m]))
  expect(by.get('sail/gpt-oss-120b')?.tier).toBe('T2')
  expect(by.get('sail/gpt-oss-120b')?.priceIn).toBeCloseTo(0.06)
  expect(by.get('sail/gpt-oss-120b')?.supportsTools).toBe(true)
  // Zero that somebody wrote down is free.
  expect(by.get('nvidia/nemotron-3-super-120b-a12b')?.tier).toBe('T1')
  // Silence is not. The row is not carried at all, rather than carried at a price it is not.
  expect(by.has('schizogpt')).toBe(false)
  // Unless the provider's own terms name it free — case aside, because ids are not consistent.
  expect(by.get('GLM-4.7-Flash')?.tier).toBe('T1')
})

test('every provider says what a missing price means, because the default is the old mistake', () => {
  for (const one of PROVIDERS) expect(one.pricing, one.id).toMatch(/^(free|published)$/)
})

test('a provider that publishes nothing but ids is still a list of models', async () => {
  const path = file()
  const catalog = new Catalog(path)
  // Groq's shape, and roughly everyone's who is not OpenRouter: no pricing, no modalities,
  // no capability list, and the context window under its own name. It used to arrive as a
  // model with a context of zero, which sorts as unusable.
  payload = { data: [{ id: 'llama-3.3-70b', object: 'model', owned_by: 'Meta', context_window: 131_072 }] }
  await catalog.refresh(provider, 0)

  const [model] = catalog.fetched
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
  expect(catalog.fetched).toHaveLength(0)

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
  expect(catalog.fetched[0]?.weekly).toBe(1000)

  // A provider that publishes nothing leaves it absent rather than zero — zero sorts as
  // unused and reads as bad, and neither is what silence means.
  payload = { data: [entry({ id: 'plain/model', canonical_slug: 'plain/model-1' })] }
  await catalog.refresh({ ...provider, id: 'quiet' }, 0)
  expect(catalog.fetched.find((m) => m.provider === 'quiet')?.weekly).toBeUndefined()

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
  expect(catalog.fetched).toHaveLength(1)
  expect(catalog.fetched[0]?.weekly).toBeUndefined()
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
  expect(upgraded.fetched).toHaveLength(1)
  expect(upgraded.fetchedFrom(provider.id)).toBe(0)
  payload = { data: [entry({ id: 'qwen/qwen3-30b:free' })] }
  expect((await upgraded.refresh(provider)).added.map((m) => m.id)).toEqual(['qwen/qwen3-30b:free'])
})

test('the written-down models are the ones somebody checked, and none of the dead ones', () => {
  const ids = SEEDED.map((m) => m.id)

  // Four catalogued Cloudflare ids return 400, 403 or 410. A dead row in a seed list is a
  // rung that fails at the moment somebody needs it rather than when somebody could notice.
  for (const dead of [
    'llama-3.3-70b-instruct',
    'llama-3.1-8b-instruct',
    'gemma-3-12b-it',
    'qwen2.5-coder-15b-instruct',
  ]) {
    expect(ids, dead).not.toContain(dead)
    expect(ids.some((id) => id.endsWith(dead)), dead).toBe(false)
  }

  // Nara pins exactly three: on a zero-balance account those were the only ids that answered,
  // and the rest of its published list is credit- or plan-gated.
  expect(SEEDED.filter((m) => m.provider === 'nara')).toHaveLength(3)

  // The keyless floor keeps its hands. Nobody but one provider publishes a tool-support flag,
  // so a discovered row reads `false` — and without these two the agent loop has nothing left
  // that can *do* anything once the keyed tiers are gone.
  const hands = SEEDED.filter((m) => m.provider === 'ovhcloud' && m.supportsTools)
  expect(hands.map((m) => m.id)).toEqual(['gpt-oss-120b', 'Meta-Llama-3_3-70B-Instruct'])

  // Every written-down row is free and belongs to a provider that exists.
  const known = new Set(PROVIDERS.map((p) => p.id))
  for (const model of SEEDED) {
    expect(known.has(model.provider), model.id).toBe(true)
    expect([model.priceIn, model.priceOut], model.id).toEqual([0, 0])
    expect(model.tier, model.id).toBe('T1')
  }
})

// ---- What a row says about itself (D159) ----------------------------------------------------

test('a router is known by an auto or router in its id or its name, and nothing else is', () => {
  // Every router on this machine's catalog and Kilo's live list on 2026-09-15, by id and name
  // as each gateway spells them.
  const routers: [string, string][] = [
    ['kilo-auto/free', 'Auto Free'],
    ['kilo-auto/small', 'Auto Small'],
    ['kilo-auto/balanced', 'Auto Balanced'],
    ['openrouter/free', 'Free Models Router'],
    ['openrouter/free', 'OpenRouter Free Models Router'],
    ['openrouter/auto', 'Auto Router'],
    ['openrouter/pareto-code', 'Pareto Code Router'],
  ]
  for (const [id, name] of routers) expect(routes({ id, name }), id).toBe(true)

  // And the near misses from the same lists: a provider called *openrouter*, a quantiser
  // called AutoRound, a model called *fast*, a `~…-latest` alias that is one model.
  const models: [string, string][] = [
    ['nvidia/nemotron-3-super-120b-a12b:free', 'NVIDIA: Nemotron 3 Super (free)'],
    ['Lorbus/Qwen3.6-27B-int4-AutoRound', 'Lorbus/Qwen3.6-27B-int4-AutoRound'],
    ['morph/morph-v3-fast', 'Morph: Morph V3 Fast'],
    ['~anthropic/claude-sonnet-latest', 'Anthropic: Claude Sonnet Latest'],
    ['openrouter/some-model', 'OpenRouter: Some Model'],
  ]
  for (const [id, name] of models) expect(routes({ id, name }), id).toBe(false)
})

test('a size is read from the id where the runner reports none, and a reported one wins', () => {
  const sizes: [string, number | undefined][] = [
    ['liquid/lfm-2.5-2.6b:free', 2.6],
    // A mixture of experts names the whole model first, and the whole model is what is read.
    ['nvidia/nemotron-3-super-120b-a12b:free', 120],
    ['ibm/granite-3.0-3b-a800m-instruct', 3],
    ['qwen3.5:397b', 397],
    ['mistralai/mixtral-8x22b-v0.1', 176],
    ['koboldcpp/Gemma-4-E4B-it-Ultra-Uncensored-Heretic', 4],
    ['koboldcpp/MN-Violet-Lotus-12B.Q8_0', 12],
    // A version number is not a size, and neither is a context length.
    ['nvidia/llama3-chatqa-1.5-70b', 70],
    ['writer/palmyra-fin-70b-32k', 70],
    ['poolside/laguna-s-2.1:free', undefined],
    ['gpt-5.5', undefined],
  ]
  for (const [id, billions] of sizes) expect(sizeOf({ id }), id).toBe(billions)
  // Ollama's own answer about a model on this machine beats whatever its name suggests.
  expect(sizeOf({ id: 'qwen3-8b-agent:latest', params: 8.2 })).toBe(8.2)
})

test('a usage figure is lent to every provider serving the same model, and never over a row’s own', () => {
  const row = (id: string, provider: string, over: Partial<Model> = {}): Model => ({
    id,
    name: id,
    provider,
    tier: 'T1',
    priceIn: 0,
    priceOut: 0,
    context: 0,
    supportsTools: true,
    modality: ['text'],
    nsfwOk: 'unknown',
    trainsOnYourData: 'unknown',
    ...over,
  })
  const lent = borrow([
    row('nvidia/nemotron-3-super-120b-a12b:free', 'kilo-gateway'),
    row('nvidia/nemotron-3-super-120b-a12b', 'nvidia'),
    row('nvidia/nemotron-3-super-120b-a12b:free', 'openrouter', { weekly: 10_043_068_411 }),
    // The same model's paid row carries the same figure on OpenRouter; the larger is taken.
    row('nvidia/nemotron-3-super-120b-a12b', 'openrouter', { weekly: 10_043_068_000 }),
    // A figure of its own is never replaced.
    row('NVIDIA/Nemotron-3-Super-120B-A12B', 'somewhere', { weekly: 7 }),
    // A router's usage is not any one model's, so it neither lends nor borrows.
    row('openrouter/free', 'openrouter', { name: 'Free Models Router', weekly: 99 }),
    row('kilo-auto/free', 'kilo-gateway', { name: 'Auto Free' }),
    row('vendor/free', 'elsewhere'),
  ])
  const by = (id: string, provider: string): Model | undefined => lent.find((m) => m.id === id && m.provider === provider)
  expect(by('nvidia/nemotron-3-super-120b-a12b:free', 'kilo-gateway')).toMatchObject({ weekly: 10_043_068_411, weeklyFrom: 'openrouter' })
  expect(by('nvidia/nemotron-3-super-120b-a12b', 'nvidia')).toMatchObject({ weekly: 10_043_068_411, weeklyFrom: 'openrouter' })
  expect(by('nvidia/nemotron-3-super-120b-a12b:free', 'openrouter')?.weeklyFrom).toBeUndefined()
  expect(by('NVIDIA/Nemotron-3-Super-120B-A12B', 'somewhere')).toMatchObject({ weekly: 7 })
  expect(by('kilo-auto/free', 'kilo-gateway')?.weekly).toBeUndefined()
  expect(by('vendor/free', 'elsewhere')?.weekly).toBeUndefined()
})

test('the catalog lends the figure when it is read, and never writes a borrowed one to the cache', async () => {
  const path = file()
  const feed = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: { analytics: { 'vendor/shared-1': { total_prompt_tokens: 40, total_completion_tokens: 2 } } } }))
  })
  await new Promise<void>((resolve) => feed.listen(0, '127.0.0.1', resolve))
  const catalog = new Catalog(path)
  payload = { data: [entry({ id: 'vendor/shared:free', canonical_slug: 'vendor/shared-1' })] }
  await catalog.refresh({ ...provider, id: 'lender', usage: `http://127.0.0.1:${(feed.address() as AddressInfo).port}/` }, 0)
  payload = { data: [entry({ id: 'other-prefix/shared' })] }
  await catalog.refresh({ ...provider, id: 'borrower' }, 0)
  feed.close()

  expect(catalog.models.find((m) => m.provider === 'borrower')).toMatchObject({ weekly: 42, weeklyFrom: 'lender' })
  // What the endpoints said is unchanged, so the next usage feed's figure is the one lent.
  expect(catalog.fetched.find((m) => m.provider === 'borrower')?.weekly).toBeUndefined()
  const { readFileSync } = await import('node:fs')
  expect(readFileSync(path, 'utf8')).not.toContain('weeklyFrom')
})

// ---- Keeping it current (model_plan.md §4 D) --------------------------------------------------

test('the lists are fetched again after six hours and not after five', async () => {
  const path = file()
  payload = { data: [entry()] }
  const catalog = new Catalog(path)
  await catalog.refresh(provider)
  // From the fetch's own stamp, not from a moment before it: six hours to the millisecond.
  const started = catalog.fetchedFrom(provider.id)

  payload = { data: [entry(), entry({ id: 'z-ai/glm-5.2:free', name: 'GLM 5.2' })] }
  const at = (hours: number): void => {
    Date.now = () => started + hours * 60 * 60 * 1000
  }
  const real = Date.now
  try {
    at(5)
    expect((await catalog.refresh(provider)).added).toEqual([])
    at(6)
    const later = await catalog.refresh(provider)
    expect(later.added.map((m) => m.id)).toEqual(['z-ai/glm-5.2:free'])
    expect(later.listKnown).toBe(true)
    // The line the Models tab shows, once, and only for a list that was known before.
    expect(news(later, { provider: 'OpenRouter', since: '09:15' })).toBe('1 new free model since 09:15: GLM 5.2 on OpenRouter. Not tried yet.')
    expect(news({ ...later, listKnown: false }, { provider: 'OpenRouter', since: '09:15' })).toBeUndefined()
    // A list whose clock a parser change reset has no time to name, and never names the epoch.
    expect(news(later, { provider: 'OpenRouter' })).toBe('1 new free model since the list was last read: GLM 5.2 on OpenRouter. Not tried yet.')
  } finally {
    Date.now = real
  }
  expect(POLL_EVERY).toBe(6 * 60 * 60 * 1000)
})

test('added is per provider, and only a list that says so has its dates read', async () => {
  const path = file()
  const other: Provider = { ...provider, id: 'other', name: 'Other' }
  payload = { data: [entry()] }
  const catalog = new Catalog(path)
  const first = await catalog.refresh(other)
  // The first fetch of a list is everything at once, and nothing in it is new.
  expect(first.listKnown).toBe(false)

  // The same model on a second provider is new there, whoever else serves it.
  const second = await catalog.refresh(provider)
  expect(second.added.map((m) => `${m.id}@${m.provider}`)).toEqual(['qwen/qwen3-8b:free@test'])

  payload = { data: [entry({ created: 1_789_000_000, expiration_date: '2026-09-30' })] }
  expect((await catalog.refresh(provider, 0)).added).toEqual([])
  expect(catalog.fetched.find((m) => m.provider === 'test')).not.toHaveProperty('created')

  const dated: Provider = { ...provider, id: 'dated', listsDates: true }
  await catalog.refresh(dated)
  expect(catalog.fetched.find((m) => m.provider === 'dated')).toMatchObject({
    created: 1_789_000_000_000,
    expires: Date.parse('2026-09-30'),
  })
})
