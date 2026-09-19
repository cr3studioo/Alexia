// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
 * **`plan-personality.md` §2's acceptance, over the wire**: *a plan with a weak model and a
 * paid one sends small; a paid model alone gets high; an old one-document row still reaches
 * every model.*
 *
 * `sizes.test.ts` holds the rules. What only this reaches is the journey — the three lengths
 * leaving a real plugin over `structuredContent`, core choosing between them for the weakest
 * rung in the step's plan, and the chosen one arriving in the system prompt a provider is
 * actually sent. Every link in that was a separate place the long document could have gone
 * out regardless.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-sized-'))
const extensions = join(import.meta.dirname, 'fixtures', 'plugins')

/** The three documents, from the files the fixture reads, so the two cannot drift apart. */
const read = (name: string): string => readFileSync(join(extensions, 'sized', `${name}.txt`), 'utf8').trim()
const THREE = { high: read('high'), medium: read('medium'), small: read('small') }
/** The one document the older fixture answers with, for *an old row still reaches every model*. */
const ONE = readFileSync(join(extensions, 'voice', 'doc.txt'), 'utf8').trim()

/** Every system prompt a model was actually sent, in order, with the model that got it. */
const sent: { model: string; system: string }[] = []
const models: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const body = JSON.parse(raw) as { model: string; messages: { role: string; content: string }[] }
    sent.push({ model: body.model, system: body.messages.find((one) => one.role === 'system')?.content ?? '' })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'said something' }, finish_reason: 'stop' }] })}\n\n` +
        `data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
    )
  })
})
await new Promise<void>((resolve) => models.listen(0, '127.0.0.1', resolve))

const stub: Provider = {
  id: 'stub',
  name: 'Stub',
  baseUrl: `http://127.0.0.1:${String((models.address() as AddressInfo).port)}/v1`,
  rpm: 1000,
  rpd: 1000,
}
const row = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: id,
  provider: 'stub',
  tier: 'T1',
  priceIn: 0,
  priceOut: 0,
  context: 131_072,
  supportsTools: true,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'unknown',
  weekly: 9_000,
  ...over,
})
noPolling(root, [
  row('vendor/free-70b', { params: 70 }),
  row('vendor/tiny-2.6b', { params: 2.6, weekly: 400 }),
  // A paid model worth buying rather than a sidegrade: it reads three times what the free ones
  // can. A paid model merely equal to the free rung it stands in for is not a rung at all, and
  // the router is right to refuse it — which would make this fixture test the wrong thing.
  row('paid/big', { tier: 'T2', priceIn: 1, priceOut: 2, params: 400, context: 400_000 }),
])

const secrets = memorySecrets()
await secrets.set(CORE, keyOf(stub), 'sk-stub')
// `local: false`, because this Mac answers on 127.0.0.1:11434 and a test that found Ollama
// would be testing Ollama.
const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: extensions,
  secrets,
  providers: [stub],
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

async function say(text: string): Promise<void> {
  const response = await fetch(new URL('/api/chat', alexia.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
    body: JSON.stringify({ text }),
  })
  await response.text()
}

/** The list of models this answer may use, as a running order somebody chose (D155). */
const plan = (...ids: string[]): void => alexia.store.kvSet(CORE, 'pins', { order: ids })

/** The trace's own account of what was sent, which is the other half of the same fact. */
const traced = async (): Promise<string> => {
  const listed = (await post('/api/rows', { key: 'activity' })) as { rows?: { id: string }[] }
  const opened = (await post('/api/detail', { key: 'activity', row: listed.rows?.[0]?.id })) as { text?: string }
  return opened.text ?? ''
}

beforeEach(() => {
  sent.length = 0
  alexia.store.kvSet(CORE, 'pins', {})
  setCaps(alexia.store, { ...caps(alexia.store), cross: true, daily: 5 })
})

expect((await post('/api/plugin', { id: 'sized', action: 'enable' })).ok).toBe(true)

test('a paid model on its own gets the long one', async () => {
  plan('paid/big')
  await say('who are you')
  expect(sent).toHaveLength(1)
  expect(sent[0]?.model).toBe('paid/big')
  expect(sent[0]?.system).toContain(THREE.high)
  expect(sent[0]?.system).not.toContain(THREE.small)
  expect(await traced()).toContain(`personality: ${String(THREE.high.length)} characters (high) sent`)
}, 30_000)

test('a plan with a 2.6B model and a paid one sends the short one, because a fallback lands there', async () => {
  // §2's acceptance in as many words. The size cannot be read off the rung that is asked
  // first: a 429 on the paid model hands the step to the 2.6B one, and the document has
  // already gone with it.
  plan('paid/big', 'vendor/tiny-2.6b')
  await say('who are you')
  // Which of the two is *asked* first is the list's own business — a paid model ranked first
  // is still paid and sorts behind every free one (D112). What this is about is the document.
  expect(sent[0]?.system).toContain(THREE.small)
  expect(sent[0]?.system).not.toContain(THREE.high)
  expect(await traced()).toContain(`personality: ${String(THREE.small.length)} characters (small) sent`)
}, 30_000)

test('a free model of a real size gets the middle one', async () => {
  plan('vendor/free-70b')
  await say('who are you')
  expect(sent[0]?.system).toContain(THREE.medium)
  expect(sent[0]?.system).not.toContain(THREE.high)
  expect(await traced()).toContain(`personality: ${String(THREE.medium.length)} characters (medium) sent`)
}, 30_000)

test('a personality with one document still reaches every model, which is what it always did', async () => {
  // The older fixture answers `text` and no `structuredContent` — the shape every persona row
  // on a real machine is in until it is adapted again. A weak model gets the long document,
  // because there is nothing shorter to send, and the trace says `high` rather than claiming a
  // choice nobody made.
  await post('/api/plugin', { id: 'sized', action: 'disable' })
  await post('/api/plugin', { id: 'voice', action: 'enable' })
  plan('vendor/tiny-2.6b')
  await say('who are you')
  expect(sent[0]?.system).toContain(ONE)
  expect(await traced()).toContain(`personality: ${String(ONE.length)} characters (high) sent`)
  await post('/api/plugin', { id: 'voice', action: 'disable' })
  await post('/api/plugin', { id: 'sized', action: 'enable' })
}, 30_000)
