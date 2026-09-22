// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, expect, test } from 'vitest'
import { noPolling } from './staged.js'
import { keyOf, type Provider } from '../src/provider.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'
import { caps, setCaps } from '../src/usage.js'

/**
 * **Hear her at a length, over the wire** (D189): a plugin hands over a personality's three
 * lengths and which to hear; core sends that length to a model the chat would give it to, under
 * the person's own paid switch, and says back what went out, on what, what it cost, and what the
 * chat would give her now. The plugin is `fixtures/hearer.js`, which asks the way Hear her asks.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-hearing-'))
const from = mkdtempSync(join(tmpdir(), 'alexia-hearing-plugin-'))

/** Which model each request went to, and the system prompt it was sent. */
const asked: { model: string; system: string }[] = []
const models: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const { model, messages } = JSON.parse(raw) as { model: string; messages: { role: string; content: string }[] }
    asked.push({ model, system: messages.find((one) => one.role === 'system')?.content ?? '' })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'I am her.' }, finish_reason: 'stop' }] })}\n\n` +
        `data: ${JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 100 } })}\n\ndata: [DONE]\n\n`,
    )
  })
})
await new Promise<void>((resolve) => models.listen(0, '127.0.0.1', resolve))

const stub: Provider = { id: 'stub', name: 'Stub', baseUrl: `http://127.0.0.1:${String((models.address() as AddressInfo).port)}/v1`, rpm: 1000, rpd: 1000 }
const row = (id: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name,
  provider: 'stub',
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
/**
 * One model the chat gives each length to: a 2B that is given the short one, a free 70B given the
 * medium one, and a paid model given the full one.
 */
noPolling(root, [
  row('free/tiny-2b', 'Tiny 2B', { weekly: 500 }),
  row('free/big-70b', 'Big 70B', { weekly: 9_000 }),
  row('paid/one', 'Paid One', { tier: 'T2', priceIn: 3, priceOut: 15, context: 128_000, weekly: 8_000 }),
])

mkdirSync(join(from, 'hearer'), { recursive: true })
writeFileSync(
  join(from, 'hearer', 'plugin.json'),
  JSON.stringify({
    manifest_version: 1,
    id: 'hearer',
    name: 'Hearer',
    summary: 'Hears a personality at one length, the way Hear her does.',
    version: '0.1.0',
    license: 'AGPL-3.0-only',
    entry: { run: 'node', args: [join(import.meta.dirname, 'fixtures', 'hearer.js')] },
    alexia_protocol: 2,
    mcp_protocol: '2025-11-25',
    settings: ['chat', 'small', 'medium', 'high'].map((hear) => ({ type: 'action', key: `hear_${hear}`, label: hear, tool: `hear_${hear}` })),
  }),
)

const secrets = memorySecrets()
await secrets.set(CORE, keyOf(stub), 'sk-stub')
const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: from,
  secrets,
  providers: [stub],
  local: false,
})
afterAll(async () => {
  await alexia.close()
  models.close()
  for (const path of [root, from]) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
  (await (
    await fetch(new URL(path, alexia.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
      body: JSON.stringify(body),
    })
  ).json()) as Record<string, unknown>

interface Told {
  sent: string
  model: string
  paid: boolean
  cost: number
  matched: boolean
  asked?: string
  chat?: { model: string; size: string }
}
/** One press of Hear her at a length: what the plugin was told, and what reached a model. */
const hear = async (at: string): Promise<{ told: Told; to: { model: string; system: string } | undefined }> => {
  asked.length = 0
  const said = String((await post('/api/action', { plugin: 'hearer', key: `hear_${at}`, approved: true })).said)
  const { told } = JSON.parse(said) as { told: Told }
  return { told, to: asked.at(-1) }
}

expect((await post('/api/plugin', { id: 'hearer', action: 'enable' })).ok).toBe(true)
beforeEach(() => setCaps(alexia.store, { ...caps(alexia.store), cross: undefined, daily: undefined }))

test('as the chat would: the model the chat asks first, given the length the chat gives it, and which that is', async () => {
  const { told, to } = await hear('chat')
  expect(to).toEqual({ model: 'free/big-70b', system: 'MEDIUM VERSION' })
  expect(told).toMatchObject({ sent: 'medium', model: 'Big 70B', paid: false, matched: true, chat: { model: 'Big 70B', size: 'medium' } })
}, 30_000)

test('smaller is a smaller model: the short one, on a model the chat gives the short one to', async () => {
  const { told, to } = await hear('small')
  expect(to).toEqual({ model: 'free/tiny-2b', system: 'SHORT VERSION' })
  expect(told).toMatchObject({ sent: 'small', asked: 'small', model: 'Tiny 2B', matched: true, paid: false })
}, 30_000)

test('medium is a free model of its size', async () => {
  const { told, to } = await hear('medium')
  expect(to).toEqual({ model: 'free/big-70b', system: 'MEDIUM VERSION' })
  expect(told).toMatchObject({ sent: 'medium', matched: true, paid: false })
}, 30_000)

test('the full one stays free with paid off: the strongest free model, and it says it is not the one the chat would use', async () => {
  const { told, to } = await hear('high')
  expect(to).toEqual({ model: 'free/big-70b', system: 'FULL VERSION' })
  expect(told).toMatchObject({ sent: 'high', asked: 'high', matched: false, paid: false, cost: 0 })
}, 30_000)

test('with paid on, the full one goes to a model the chat gives it to — and says it is paid, and what it cost', async () => {
  setCaps(alexia.store, { ...caps(alexia.store), cross: true, daily: 1 })
  const { told, to } = await hear('high')
  expect(to).toEqual({ model: 'paid/one', system: 'FULL VERSION' })
  expect(told).toMatchObject({ sent: 'high', model: 'Paid One', matched: true, paid: true })
  // 1,000 in at $3 a million and 100 out at $15: $0.0045.
  expect(told.cost).toBeCloseTo(0.0045, 6)
  // The chat's own answer does not move with it: free first, paid only once the free ones are
  // done — so what she gets in the chat is still the medium one, and the sample says both.
  expect(told.chat).toEqual({ model: 'Big 70B', size: 'medium' })
}, 30_000)
