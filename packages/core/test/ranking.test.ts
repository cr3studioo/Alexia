// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { noPolling } from './staged.js'
import type { Model } from '../src/catalog.js'
import { BUSY_HALF_LIFE } from '../src/health.js'
import { remaining } from '../src/pool.js'
import type { Provider } from '../src/provider.js'
import { MODES, ranking, route, sunk, type Choice, type Pins, type Strike, type World } from '../src/router.js'
import { memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'
import { Store, type Outcome } from '../src/store.js'

/**
 * **Best to worst, on the screen** (D159).
 *
 * The router's suite holds the order. What only this can reach is that the Models tab tells the
 * same story the router walks — a router labelled and last, a borrowed usage figure saying
 * whose it is, and a ★ that moves off a model the moment it has failed in a real conversation,
 * because the ★ is defined as `route()`'s first choice and the failure was written down by `send()`.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-ranking-'))

/** Models that answer with a status instead of words. Everything else answers. */
let failing = new Set<string>()
const asked: string[] = []
const models: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const { model } = JSON.parse(raw) as { model: string }
    asked.push(model)
    if (failing.has(model)) {
      response.writeHead(429, { 'content-type': 'text/plain' })
      response.end('slow down')
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: `from ${model}` } }] })}\n\n` +
        `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
    )
  })
})
await new Promise<void>((resolve) => models.listen(0, '127.0.0.1', resolve))

/** A provider that answers without a key — the only kind a fresh install has. */
const floor: Provider = {
  id: 'floor',
  name: 'Floor',
  baseUrl: `http://127.0.0.1:${(models.address() as AddressInfo).port}/v1`,
  auth: 'optional',
  rpm: 1000,
  rpd: 1000,
}

const row = (id: string, provider: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: id,
  provider,
  tier: 'T1',
  priceIn: 0,
  priceOut: 0,
  context: 262_144,
  supportsTools: true,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'unknown',
  ...over,
})
// Listed the way Kilo lists them — its router first — so the file's order is not what decides.
noPolling(root, [
  row('kilo-auto/free', 'floor', { name: 'Auto Free' }),
  row('vendor/busy:free', 'floor', { name: 'Busy' }),
  row('vendor/large-120b-a12b:free', 'floor', { name: 'Large' }),
  // The same model on a provider nobody here has connected, which publishes a usage figure.
  row('vendor/busy:free', 'lender', { name: 'Busy', weekly: 5_000_000 }),
])

const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: join(root, 'extensions'),
  secrets: memorySecrets(),
  providers: [floor],
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

const tab = async (): Promise<{ id: string; state: string; week: string; note: string; group: string }[]> =>
  ((await post('/api/rows', { key: 'models' })).rows ?? []) as { id: string; state: string; week: string; note: string; group: string }[]

/** One POST to `/api/chat`, read to the end. */
const chat = async (text: string): Promise<string> =>
  (
    await fetch(new URL('/api/chat', alexia.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
      body: JSON.stringify({ text }),
    })
  ).text()

test('the Models tab labels a router and puts it last, and says whose usage figure a row borrowed', async () => {
  const rows = await tab()
  // A size read from the id before a size nobody said; a router after both.
  expect(rows.map((one) => one.id)).toEqual(['floor\nvendor/large-120b-a12b:free', 'floor\nvendor/busy:free', 'floor\nkilo-auto/free'])
  expect(rows.every((one) => one.group === 'Automatic, free')).toBe(true)
  expect(rows[0]?.state).toBe('★ recommended')
  expect(rows[2]?.state).toBe('● ready · a different free model each time')
  // Whose figure it is, when it was lent (D159) — on the row now, not only in the detail.
  expect(rows[1]?.week).toBe('5.0M via lender')
  // And why each sits below the one above, in the ranking's own words (D161).
  expect(rows[1]?.note).toBe('Its size isn’t published, so it comes after models known to be 7B or more.')
  expect(rows[2]?.note).toBe('A router: a different free model each time, some of them tiny. Asked after every single model.')

  const router = String((await post('/api/detail', { key: 'models', row: 'floor\nkilo-auto/free' })).text)
  expect(router).toContain('A router: a different free model each time, chosen by floor.')
  const busy = String((await post('/api/detail', { key: 'models', row: 'floor\nvendor/busy:free' })).text)
  expect(busy).toContain('last week on lender, which publishes the figure floor does not.')
})

test('a model that fails in a conversation loses the ★, and the next conversation starts elsewhere', async () => {
  failing = new Set(['vendor/large-120b-a12b:free'])
  asked.length = 0
  expect(await chat('what is on today')).toContain('from vendor/busy:free')
  expect(asked).toEqual(['vendor/large-120b-a12b:free', 'vendor/busy:free'])
  expect(alexia.store.strikes().map((one) => one.model)).toEqual(['vendor/large-120b-a12b:free'])

  // The ★ is the router's first choice, so it moves with the failure rather than beside it.
  expect((await tab()).find((one) => one.state === '★ recommended')?.id).toBe('floor\nvendor/busy:free')

  // And the next question does not collect the same 429 first.
  asked.length = 0
  expect(await chat('and tomorrow')).toContain('from vendor/busy:free')
  expect(asked).toEqual(['vendor/busy:free'])
  failing = new Set()
}, 30_000)

// ---- Busy for minutes, failed for the hour, and down by the provider's own word --------------

const MINUTE = 60_000
/** Noon UTC on 22 September 2026. */
const noon = Date.UTC(2026, 8, 22, 12)
const alpha: Provider = { id: 'alpha', name: 'Alpha', baseUrl: 'http://127.0.0.1:1', rpm: 1000, rpd: 1000 }
const hands = (id: string, over: Partial<Model> = {}): Model => ({
  id,
  name: id,
  provider: 'alpha',
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
const choice = (model: Model): Choice => ({ model, provider: alpha })
const strike = (model: string, outcome: Outcome, minutesAgo: number): Strike => ({
  provider: 'alpha',
  model,
  at: noon - minutesAgo * MINUTE,
  outcome,
})
const work = { messages: [{ role: 'user' as const, content: 'sort my downloads' }], tools: [{ name: 'fs.list' }] }
const pins = (over: Partial<Pins> = {}): Pins => ({ placement: MODES.combined, ...over })
const ids = (verdict: ReturnType<typeof route>): string[] => (verdict.ok ? verdict.choices.map((c) => c.model.id) : [verdict.why])

test('a busy reply sinks a model for a couple of minutes; any other failure still for about an hour', () => {
  const key = 'alpha\nm'
  const busy = [strike('m', 'busy', 0)]
  expect(BUSY_HALF_LIFE).toBe(2 * MINUTE)
  expect(sunk(busy, noon).get(key)).toBe(1)
  expect(sunk(busy, noon + MINUTE).get(key)).toBe(1)
  expect(sunk(busy, noon + 2.5 * MINUTE).get(key)).toBeUndefined()
  expect(sunk(busy, noon + 4 * MINUTE).get(key)).toBeUndefined()

  const failed = [strike('m', 'failed', 0)]
  expect(sunk(failed, noon + 4 * MINUTE).get(key)).toBe(1)
  expect(sunk(failed, noon + 55 * MINUTE).get(key)).toBe(1)
  expect(sunk(failed, noon + 65 * MINUTE).get(key)).toBeUndefined()
  // A strike made by hand says nothing of how it went, and counts as a failure.
  expect(sunk([{ provider: 'alpha', model: 'm', at: noon }], noon + 30 * MINUTE).get(key)).toBe(1)

  // Four busy replies together sink it for six minutes, where four failures would take three hours.
  const four = [0, 0, 0, 0].map(() => strike('m', 'busy', 0))
  expect(sunk(four, noon + 5.5 * MINUTE).get(key)).toBe(1)
  expect(sunk(four, noon + 6.5 * MINUTE).get(key)).toBeUndefined()
})

test('a model busy three minutes ago is back beside its equal, and the why-line says minutes for busy and the hour for a failure', () => {
  const qwen = hands('qwen/qwen3.8-27b:free', { name: 'Qwen 3.8' })
  const twin = hands('vendor/twin-27b', { name: 'Twin' })
  const busyAgo = (minutes: number) => ranking({ strikes: [strike(qwen.id, 'busy', minutes)] }, 'cheap', noon)

  expect(busyAgo(1).decides(choice(qwen), choice(twin))).toBe('struck')
  expect(busyAgo(1).explain(choice(qwen), choice(twin))).toBe('Was busy recently, so it sits below Twin for a couple of minutes.')
  expect(busyAgo(3).compare(choice(qwen), choice(twin))).toBe(0)
  expect(busyAgo(3).decides(choice(qwen), choice(twin))).toBeUndefined()

  const streak = ranking({ strikes: [1, 1, 1].map((ago) => strike(qwen.id, 'busy', ago)) }, 'cheap', noon)
  expect(streak.explain(choice(qwen), choice(twin))).toBe('Was busy recently, so it sits below Twin for a few minutes.')

  // A failure keeps its hour, and says so even when the latest strike was a busy reply.
  const failed = ranking({ strikes: [strike(qwen.id, 'slow', 10), strike(qwen.id, 'busy', 1)] }, 'cheap', noon)
  expect(failed.explain(choice(qwen), choice(twin))).toBe('Failed here recently, so it sits below Twin for about an hour.')
  expect(ranking({ strikes: [strike(qwen.id, 'failed', 3)] }, 'cheap', noon).decides(choice(qwen), choice(twin))).toBe('struck')
})

test('a model its provider says is down is asked after one that is up, never dropped, and a pin on it still wins', () => {
  const qwen = hands('qwen/qwen3.8-27b:free', { name: 'Qwen 3.8', weekly: 9_000 })
  const other = hands('vendor/other-27b', { name: 'Other', weekly: 1 })
  const down = new Set(['alpha\nqwen/qwen3.8-27b:free'])

  const ranked = ranking({ down })
  expect(ranked.decides(choice(qwen), choice(other))).toBe('down')
  expect(ranked.explain(choice(qwen), choice(other))).toBe(
    'Its provider’s own status shows every host serving it down in the last five minutes, so it comes after models that are up.',
  )
  // Handed over the other way round, it is still the lower one's sentence.
  expect(ranked.explain(choice(other), choice(qwen))).toBe(ranked.explain(choice(qwen), choice(other)))
  // Without a status, the busier model is first.
  expect(ranking({}).decides(choice(other), choice(qwen))).toBe('usage')

  const ledger = new Store(':memory:')
  const world = (over: Partial<World> = {}): World => ({
    models: [qwen, other],
    local: [],
    rungs: [remaining(ledger, alpha)],
    today: { spent: 0, allowance: 1 },
    ...over,
  })
  expect(ids(route(work, pins(), world()))).toEqual([qwen.id, other.id])
  expect(ids(route(work, pins(), world({ down })))).toEqual([other.id, qwen.id])
  expect(ids(route(work, pins({ model: qwen.id }), world({ down })))).toEqual([qwen.id])

  // What failed on this machine comes before a status page about everyone's.
  const both = ranking({ down, strikes: [strike(other.id, 'failed', 1)] }, 'cheap', noon)
  expect(both.decides(choice(other), choice(qwen))).toBe('struck')
  ledger.close()
})
