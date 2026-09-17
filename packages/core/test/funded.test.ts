// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { accountKey, remaining } from '../src/pool.js'
import type { Provider } from '../src/provider.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'

/**
 * `model_plan.md` §4 D step 12, and §1's *Funded*: **the provider's own word on the account.**
 *
 * OpenRouter's fifty free requests a day become a thousand once an account has bought credit, and
 * nothing told Alexia which it was (D107 kept the low guess on purpose). Its key endpoint says —
 * `is_free_tier`, and `limit_remaining` on the key — so it is read when a key is saved and on every
 * tick, and it decides the day's allowance and whether the paid models can be listed at all.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-funded-'))

let account: { is_free_tier: boolean; limit_remaining: number | null } = { is_free_tier: true, limit_remaining: null }
const gateway: Server = createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer sk-or') {
    response.writeHead(401)
    response.end()
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  if (request.url === '/v1/key') {
    response.end(JSON.stringify({ data: { label: 'sk-or…', usage: 0, limit: null, ...account } }))
    return
  }
  response.end(
    JSON.stringify({
      data: [
        { id: 'free/one', name: 'Free One', pricing: { prompt: '0', completion: '0' }, context_length: 32_768, supported_parameters: ['tools'] },
        { id: 'paid/one', name: 'Paid One', pricing: { prompt: '0.000003', completion: '0.000015' }, context_length: 200_000, supported_parameters: ['tools'] },
      ],
    }),
  )
})
await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))

const router: Provider = {
  id: 'router',
  name: 'Router',
  baseUrl: `http://127.0.0.1:${String((gateway.address() as AddressInfo).port)}/v1`,
  models: '/models',
  keyInfo: '/key',
  pricing: 'published',
  rpm: 20,
  rpd: 50,
  rpdFunded: 1000,
}

const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: join(root, 'extensions'),
  secrets: memorySecrets(),
  providers: [router],
  local: false,
})

afterAll(async () => {
  await alexia.close()
  gateway.close()
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

const listed = async (): Promise<string[]> =>
  (((await post('/api/rows', { key: 'models' })).rows ?? []) as { group: string; name: string }[]).map((row) => `${row.group}: ${row.name}`)

test('an account on the free tier gets the free day and no paid models; one that bought credit gets both', async () => {
  const saved = await post('/api/setup', { provider: { id: 'router', key: 'sk-or' } })
  expect(saved.said).toBe('Router connected — 1 free model. Its paid models are not listed: Router says this account has no credit yet.')
  expect(await listed()).toEqual(['Automatic, free: Free One'])
  expect(remaining(alexia.store, router).day).toBe(50)

  account = { is_free_tier: false, limit_remaining: null }
  expect((await post('/api/setup', { provider: { id: 'router', key: 'sk-or' } })).said).toBe('Router connected — 1 free model and 1 paid.')
  expect(await listed()).toEqual(['Automatic, free: Free One', 'Paid: Paid One'])
  // The real figure replaces the deliberately low guess.
  expect(remaining(alexia.store, router).day).toBe(1000)

  // A key whose own credit limit is spent is unfunded, whatever the account once bought.
  account = { is_free_tier: false, limit_remaining: 0 }
  expect(String((await post('/api/setup', { provider: { id: 'router', key: 'sk-or' } })).said)).toContain("this key's credit limit is used up")
  expect(await listed()).toEqual(['Automatic, free: Free One'])

  // What was said about the account goes with the key.
  await post('/api/setup', { provider: { id: 'router', remove: true } })
  expect(alexia.store.kvGet(CORE, accountKey('router'))).toBeUndefined()
}, 30_000)
