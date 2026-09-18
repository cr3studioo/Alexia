// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { noPolling } from './staged.js'
import type { Provider } from '../src/provider.js'
import { memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'

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
