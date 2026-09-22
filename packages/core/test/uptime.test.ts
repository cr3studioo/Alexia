// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import type { Provider } from '../src/provider.js'
import type { Outcome } from '../src/store.js'
import { DOWN_BELOW, FRESH_FOR, reading, Uptime, WATCHED, watched, type Watched } from '../src/uptime.js'

/**
 * **OpenRouter's own word on whether a model's hosts are up** (A8): read from its public endpoints
 * page, a minute at a time, and never waited for by an answer.
 */

const openrouter: Provider = { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://status.test/api/v1' }
const floor: Provider = { id: 'floor', name: 'Floor', baseUrl: 'https://floor.test/v1', auth: 'optional' }

/** A page the way OpenRouter gives it on 22 September 2026, cut to what matters here. */
const page = (...uptimes: (number | null)[]): unknown => ({
  data: {
    id: 'qwen/qwen3.8-27b:free',
    endpoints: uptimes.map((uptime, i) => ({
      name: `Host ${String(i)}`,
      provider_name: `Host ${String(i)}`,
      status: 0,
      uptime_last_30m: 99.9,
      uptime_last_5m: uptime,
      uptime_last_1d: 99.9,
    })),
  },
})

test('a page is down only when it lists hosts and every one is under half its last five minutes', () => {
  expect(DOWN_BELOW).toBe(50)
  // Qwen 3.8's one host, as it read on 22 September.
  expect(reading(page(99.63503649635037))).toBe('up')
  expect(reading(page(12, 0))).toBe('down')
  expect(reading(page(49.9))).toBe('down')
  expect(reading(page(50))).toBe('up')
  // One host up is enough, however many are down.
  expect(reading(page(3, 4, 98))).toBe('up')
  // A host with no figure may be the one that is fine: not down.
  expect(reading(page(12, null))).toBe('unknown')
  expect(reading(page(null))).toBe('unknown')
  // No hosts listed — a model OpenRouter no longer serves free — is not known to be down.
  expect(reading(page())).toBe('unknown')
  // And a page of some other shape is nothing to go on.
  for (const odd of [null, undefined, 'nope', 42, {}, { data: null }, { data: { endpoints: 'x' } }, { data: { endpoints: [null] } }]) {
    expect(reading(odd)).toBe('unknown')
  }
  expect(reading({ data: { endpoints: [{ uptime_last_5m: '12' }] } })).toBe('unknown')
})

// ---- The cache: a minute old at most, and never waited for ------------------------------------

/** A provider's status pages, and every request that reached them. */
const fake = (pages: Record<string, unknown | Error | number>) => {
  const asked: { url: string; init: RequestInit | undefined }[] = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), init })
    const found = pages[String(url)]
    if (found instanceof Error) throw found
    if (typeof found === 'number') return new Response('no', { status: found })
    return Response.json(found ?? { error: { message: 'Not Found', code: 404 } }, { status: found === undefined ? 404 : 200 })
  }) as typeof fetch
  return { fetcher, asked }
}
const url = (model: string): string => `https://status.test/api/v1/models/${model}/endpoints`
const qwen: Watched = { provider: openrouter, model: 'qwen/qwen3.8-27b:free' }
const gemma: Watched = { provider: openrouter, model: 'google/gemma-4-31b-it:free' }

test('the first ask answers at once with nothing known, and the read it starts is there for the next', async () => {
  const { fetcher, asked } = fake({
    [url('qwen/qwen3.8-27b%3Afree')]: page(4),
    [url('google/gemma-4-31b-it%3Afree')]: page(99),
  })
  let now = 1_000_000
  const uptime = new Uptime({ fetch: fetcher, now: () => now })

  expect([...uptime.down(() => [qwen, gemma])]).toEqual([])
  await uptime.settled()
  expect([...uptime.down(() => [qwen, gemma])]).toEqual(['openrouter\nqwen/qwen3.8-27b:free'])
  // One GET per model, carrying nothing but the id: no key, no words.
  expect(asked.map((one) => one.url)).toEqual([url('qwen/qwen3.8-27b%3Afree'), url('google/gemma-4-31b-it%3Afree')])
  for (const one of asked) {
    expect(one.init?.method ?? 'GET').toBe('GET')
    expect(one.init?.body).toBeUndefined()
    expect(one.init?.headers).toEqual({ accept: 'application/json' })
    expect(one.init?.signal).toBeInstanceOf(AbortSignal)
  }

  // Inside the minute: the same answer, and nothing asked.
  now += FRESH_FOR - 1
  let listed = 0
  expect(uptime.down(() => (listed++, [qwen, gemma])).size).toBe(1)
  expect(asked).toHaveLength(2)
  // Not even the list of models is worked out while the read is fresh.
  expect(listed).toBe(0)
})

test('a stale read starts exactly one fresh read behind it, and the old answer stands until it lands', async () => {
  const pages: Record<string, unknown> = { [url('qwen/qwen3.8-27b%3Afree')]: page(4) }
  const { fetcher, asked } = fake(pages)
  let now = 1_000_000
  const uptime = new Uptime({ fetch: fetcher, now: () => now })
  uptime.down(() => [qwen])
  await uptime.settled()
  expect(asked).toHaveLength(1)

  // A minute on, the host has come back.
  now += FRESH_FOR
  pages[url('qwen/qwen3.8-27b%3Afree')] = page(97)
  const meanwhile = [uptime.down(() => [qwen]), uptime.down(() => [qwen]), uptime.down(() => [qwen])]
  // Three asks while it reads: every one answered from the old read, and one request between them.
  expect(meanwhile.map((set) => [...set])).toEqual([
    ['openrouter\nqwen/qwen3.8-27b:free'],
    ['openrouter\nqwen/qwen3.8-27b:free'],
    ['openrouter\nqwen/qwen3.8-27b:free'],
  ])
  await uptime.settled()
  expect(asked).toHaveLength(2)
  expect([...uptime.down(() => [qwen])]).toEqual([])
})

test('a read that fails is not down, and never throws', async () => {
  const { fetcher, asked } = fake({
    [url('qwen/qwen3.8-27b%3Afree')]: new TypeError('fetch failed'),
    [url('google/gemma-4-31b-it%3Afree')]: 503,
  })
  const thrower = (() => {
    throw new Error('no network at all')
  }) as unknown as typeof fetch
  const uptime = new Uptime({ fetch: fetcher, now: () => 5 })
  expect(() => uptime.down(() => [qwen, gemma])).not.toThrow()
  await expect(uptime.settled()).resolves.toBeUndefined()
  expect(uptime.down(() => [qwen, gemma]).size).toBe(0)
  expect(asked).toHaveLength(2)

  const broken = new Uptime({ fetch: thrower, now: () => 5 })
  expect(() => broken.down(() => [qwen])).not.toThrow()
  await expect(broken.settled()).resolves.toBeUndefined()
  expect(broken.down(() => [qwen]).size).toBe(0)
})

test('nothing to look at asks nothing, and one read looks at five models at most', async () => {
  const { fetcher, asked } = fake({})
  const uptime = new Uptime({ fetch: fetcher, now: () => 5 })
  expect(uptime.down(() => []).size).toBe(0)
  await uptime.settled()
  expect(asked).toHaveLength(0)

  const many = Array.from({ length: 8 }, (_, i): Watched => ({ provider: openrouter, model: `vendor/m${String(i)}` }))
  uptime.down(() => many)
  await uptime.settled()
  expect(WATCHED).toBe(5)
  expect(asked).toHaveLength(5)
})

// ---- Which models: the pin, then what answered here most lately --------------------------------

const rungs = [{ provider: floor }, { provider: openrouter }]
const listed = (provider: string, ...ids: string[]) => ids.map((id) => ({ provider, id }))
const tried = (model: string, outcome: Outcome, at: number, provider = 'openrouter') => ({ provider, model, outcome, at })
const names = (picked: Watched[]): string[] => picked.map((one) => `${one.provider.id}\n${one.model}`)

test('the models looked at are the pinned one and the ones that answered here most lately, five at most, all on a provider that publishes', () => {
  const models = [
    ...listed('openrouter', 'pinned/one', 'a', 'b', 'c', 'd', 'e', 'f', 'gone-quiet'),
    ...listed('floor', 'a', 'floor-only'),
  ]
  const tries = [
    tried('a', 'answered', 1),
    tried('b', 'answered', 2),
    tried('c', 'busy', 3),
    tried('d', 'answered', 4),
    tried('floor-only', 'answered', 5, 'floor'),
    tried('a', 'answered', 6),
    tried('e', 'answered', 7),
    tried('left-the-catalog', 'answered', 8),
    tried('f', 'answered', 9),
    tried('b', 'failed', 10),
  ]

  expect(names(watched(rungs, models, tries, 'pinned/one'))).toEqual([
    'openrouter\npinned/one',
    'openrouter\nf',
    'openrouter\ne',
    'openrouter\na',
    'openrouter\nd',
  ])
  // Without a pin, the five that answered most lately, each once.
  expect(names(watched(rungs, models, tries))).toEqual(['openrouter\nf', 'openrouter\ne', 'openrouter\na', 'openrouter\nd', 'openrouter\nb'])
  // A pin on a model OpenRouter does not serve is not looked at.
  expect(names(watched(rungs, models, tries, 'floor-only'))[0]).toBe('openrouter\nf')
  // Nothing at all when OpenRouter is not a rung right now — no key, or its day used up.
  expect(watched([{ provider: floor }], models, tries, 'pinned/one')).toEqual([])
  // And the order the record arrives in does not matter: most recent first either way.
  expect(names(watched(rungs, models, [...tries].reverse()))).toEqual(names(watched(rungs, models, tries)))
  // The rung's own provider is what is handed over, so its own address is the one asked.
  expect(watched(rungs, models, tries)[0]?.provider).toBe(openrouter)
})
