// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { keyOf, type Provider } from '../src/provider.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'

/**
 * `model_plan.md` §4 D: **the table keeps itself current.** A fetch of a provider's list writes
 * down what arrived, the Models tab says so once, and a model that arrived is *new* — at the
 * bottom of its group — until it answers, then at the middle of models its size until the world's
 * figure for it arrives, which places it up or down (D161's *New* acceptance).
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-current-'))

type Listed = { id: string; name: string; weekly?: number }
/** What the provider lists right now. */
let listed: Listed[] = []
const lists: Server = createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer sk-list') {
    response.writeHead(401)
    response.end('no key')
    return
  }
  const free = { prompt: '0', completion: '0' }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify({
      data: listed.map((one) => ({ id: one.id, canonical_slug: one.id, name: one.name, pricing: free, context_length: 32_768, supported_parameters: ['tools'] })),
    }),
  )
})
await new Promise<void>((resolve) => lists.listen(0, '127.0.0.1', resolve))
const port = (lists.address() as AddressInfo).port

/** The world's usage figures, served where OpenRouter serves its own. */
const usage: Server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  const analytics = Object.fromEntries(
    listed.filter((one) => one.weekly !== undefined).map((one) => [one.id, { total_prompt_tokens: one.weekly, total_completion_tokens: 0 }]),
  )
  response.end(JSON.stringify({ data: { analytics } }))
})
await new Promise<void>((resolve) => usage.listen(0, '127.0.0.1', resolve))

const stub: Provider = {
  id: 'stub',
  name: 'Stub',
  baseUrl: `http://127.0.0.1:${String(port)}/v1`,
  models: '/models',
  usage: `http://127.0.0.1:${String((usage.address() as AddressInfo).port)}/usage`,
  pricing: 'published',
  rpm: 1000,
  rpd: 1000,
}

const secrets = memorySecrets()
// No cache at all: a fresh install. The startup poll has no key, so the list is refused.
const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: join(root, 'extensions'),
  secrets,
  providers: [stub],
  local: false,
})

afterAll(async () => {
  await alexia.close()
  lists.close()
  usage.close()
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

/** The Models tab: its line above the rows, and the Automatic group as `name [tags]`. */
const tab = async (): Promise<{ note: unknown; automatic: string[] }> => {
  const answer = await post('/api/rows', { key: 'models' })
  const rows = (answer.rows ?? []) as { group: string; name: string; tags: { says: string }[] }[]
  return {
    note: answer.note,
    automatic: rows
      .filter((row) => row.group === 'Automatic, free')
      .map((row) => `${row.name}${row.tags.length === 0 ? '' : ` [${row.tags.map((tag) => tag.says).join(', ')}]`}`),
  }
}

/** Saving the key fetches the list at once, which is the fetch this test steps through. */
const fetched = (): Promise<Record<string, unknown>> => post('/api/setup', { provider: { id: stub.id, key: 'sk-list' } })

test('a model that arrives on a list already known is new and last, answers into the middle of its size, and is placed by its figure', async () => {
  // The first fetch this machine makes of the list: everything is first seen at once, nothing is new.
  listed = [
    { id: 'vendor/big-70b', name: 'Big', weekly: 900 },
    { id: 'vendor/mid-70b', name: 'Mid', weekly: 500 },
    { id: 'vendor/low-70b', name: 'Low', weekly: 100 },
    { id: 'vendor/least-70b', name: 'Least', weekly: 10 },
  ]
  await fetched()
  const first = await tab()
  expect(first.note).toBeUndefined()
  expect(first.automatic).toEqual(['Big', 'Mid', 'Low', 'Least'])
  expect(alexia.store.seen().every((one) => !one.listKnown)).toBe(true)

  // The second fetch brings a model: new, said once above the table, and last in its group.
  listed = [...listed, { id: 'vendor/fresh-70b', name: 'Fresh' }]
  await fetched()
  const arrived = await tab()
  expect(String(arrived.note)).toMatch(/^1 new free model since .+: Fresh on Stub\. Not tried yet\.$/)
  expect(arrived.automatic).toEqual(['Big', 'Mid', 'Low', 'Least', 'Fresh [new · not tried yet]'])

  // One good reply: no longer new, and ranked as if its figure were the middle of its size's (300).
  alexia.store.recordTry({ provider: 'stub', model: 'vendor/fresh-70b', outcome: 'answered', status: 200, source: 'test' })
  expect((await tab()).automatic).toEqual(['Big', 'Mid', 'Fresh', 'Low', 'Least'])

  // The world's figure arrives on the next fetch, and it places the model — down, this time. And a
  // fetch that added nothing has nothing to say: the news was said once.
  listed = listed.map((one) => (one.id === 'vendor/fresh-70b' ? { ...one, weekly: 50 } : one))
  await fetched()
  const placed = await tab()
  expect(placed.note).toBeUndefined()
  expect(placed.automatic).toEqual(['Big', 'Mid', 'Low', 'Fresh', 'Least'])

  // A model that leaves the list is written down as gone, and comes back clean.
  listed = listed.filter((one) => one.id !== 'vendor/least-70b')
  await fetched()
  expect(alexia.store.seen().find((one) => one.model === 'vendor/least-70b')?.goneAt).toBeGreaterThan(0)
  listed = [...listed, { id: 'vendor/least-70b', name: 'Least', weekly: 10 }]
  await fetched()
  expect(alexia.store.seen().find((one) => one.model === 'vendor/least-70b')?.goneAt).toBeUndefined()
  expect(await secrets.get(CORE, keyOf(stub))).toBe('sk-list')
}, 30_000)
