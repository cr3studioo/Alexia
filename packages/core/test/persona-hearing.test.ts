// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, expect, test } from 'vitest'
import { noPolling, stage } from './staged.js'
import { keyOf, type Provider } from '../src/provider.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'
import { caps, setCaps } from '../src/usage.js'

/**
 * **Hear her, pressed on the real persona plugin** (D189): *Hear her at* chooses the length, the
 * sample goes to a model the chat would give that length to — free unless paid is on — and what
 * comes back says which length the chat gives her now, which one this was, and, on a paid model,
 * that it was paid and what it cost.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-persona-hearing-'))
const from = stage('persona')

const asked: { model: string; system: string }[] = []
const models: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const { model, messages } = JSON.parse(raw) as { model: string; messages: { role: string; content: string }[] }
    asked.push({ model, system: messages.find((one) => one.role === 'system')?.content ?? '' })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: `Hello from ${model}.` }, finish_reason: 'stop' }] })}\n\n` +
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
noPolling(root, [
  row('free/tiny-2b', 'Tiny 2B', { weekly: 500 }),
  row('free/big-70b', 'Big 70B', { weekly: 9_000 }),
  row('paid/one', 'Paid One', { tier: 'T2', priceIn: 3, priceOut: 15, context: 128_000, weekly: 8_000 }),
])

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

expect((await post('/api/plugin', { id: 'persona', action: 'enable' })).ok).toBe(true)
// A saved personality in three lengths nobody could mistake for one another, the way Adapt saves one.
const id = alexia.store.insert('persona', 'personalities', {
  name: 'Chief of staff',
  doc: '# Chief of staff\n\nFULL VERSION',
  doc_medium: '# Chief of staff\n\nMEDIUM VERSION',
  doc_small: '# Chief of staff\n\nSHORT VERSION',
  described: 'blunt',
  wrote: 'test',
  channel: '',
  active: 0,
  at: Date.now(),
})

/** Set *Hear her at*, press Hear her on the row, and return what came back and what reached a model. */
const hear = async (at: string): Promise<{ said: string; to: { model: string; system: string }[] }> => {
  expect((await post('/api/settings', { plugin: 'persona', key: 'hear_length', value: at })).ok).not.toBe(false)
  asked.length = 0
  const said = String((await post('/api/action', { plugin: 'persona', key: 'hear', row: String(id), approved: true })).said)
  return { said, to: [...asked] }
}

beforeEach(() => setCaps(alexia.store, { ...caps(alexia.store), cross: undefined, daily: undefined }))

test('by default she is heard as the chat would hear her, and told which length that is', async () => {
  const { said, to } = await hear('chat')
  expect(to.every((one) => one.model === 'free/big-70b' && one.system.includes('MEDIUM VERSION'))).toBe(true)
  expect(said).toContain('In your chat right now, Big 70B answers first and is given her medium (about 300 words) version.')
  expect(said).toContain('This sample is her medium (about 300 words) version, on Big 70B.')
}, 60_000)

test('Short is the short one on a smaller model', async () => {
  const { said, to } = await hear('small')
  expect(to.every((one) => one.model === 'free/tiny-2b' && one.system.includes('SHORT VERSION'))).toBe(true)
  expect(said).toContain('This sample is her short (about 100 words) version, on Tiny 2B.')
}, 60_000)

test('Full with paid off stays free, and says the chat would only give it to a paid model', async () => {
  const { said, to } = await hear('high')
  expect(to.every((one) => one.model === 'free/big-70b' && one.system.includes('FULL VERSION'))).toBe(true)
  expect(said).toContain('only paid models are given the full version in the chat, and paid models are off under Models')
  expect(said).not.toContain('⚠')
}, 60_000)

test('Full with paid on is the paid model, and the sample warns that it cost money', async () => {
  setCaps(alexia.store, { ...caps(alexia.store), cross: true, daily: 1 })
  const { said, to } = await hear('high')
  expect(to.every((one) => one.model === 'paid/one' && one.system.includes('FULL VERSION'))).toBe(true)
  expect(said).toContain('This sample is her full (about 600 words) version, on Paid One.')
  expect(said).toContain('⚠ Paid One is a paid model: hearing her cost about $0.0045.')
}, 60_000)
