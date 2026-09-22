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
 * leaving a real plugin over `structuredContent`, core choosing between them for the model each
 * call goes to, and the chosen one arriving in the system prompt a provider is actually sent. Every link in that was a separate place the long document could have gone
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
/** Models that answer 429, so the step falls back to the next rung. */
const busy = new Set<string>()
const models: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const body = JSON.parse(raw) as { model: string; messages: { role: string; content: string }[] }
    sent.push({ model: body.model, system: body.messages.find((one) => one.role === 'system')?.content ?? '' })
    if (busy.has(body.model)) {
      response.writeHead(429, { 'content-type': 'application/json' })
      // A day's allowance spent, not a host busy for a second: a 429 asking again cannot clear.
      response.end(JSON.stringify({ error: { message: 'busy: free-models-per-day' } }))
      return
    }
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
  busy.clear()
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

test('a strong model at the head of a plan gets its own length, whatever is at the tail', async () => {
  // The size used to be chosen for the weakest rung in the whole plan, and a plan is every
  // model that fits — so the 2.6B at the tail decided what the 70B that answered was told, and
  // in practice nearly every step sent the short one. It is chosen per model asked now.
  plan('vendor/free-70b', 'vendor/tiny-2.6b')
  await say('who are you')
  expect(sent).toHaveLength(1)
  expect(sent[0]?.model).toBe('vendor/free-70b')
  expect(sent[0]?.system).toContain(THREE.medium)
  expect(sent[0]?.system).not.toContain(THREE.small)
  expect(await traced()).toContain(`personality: ${String(THREE.medium.length)} characters (medium) sent`)
}, 30_000)

test('a fallback to a 2.6B model is sent the short one, and the trace says both', async () => {
  // §2's own worry, and still held: a 429 hands the step to the next rung, and the 2.6B model
  // that answers it is never handed the long document.
  busy.add('vendor/free-70b')
  plan('vendor/free-70b', 'vendor/tiny-2.6b')
  await say('who are you')
  expect(sent.map((one) => one.model)).toEqual(['vendor/free-70b', 'vendor/tiny-2.6b'])
  expect(sent[0]?.system).toContain(THREE.medium)
  expect(sent[1]?.system).toContain(THREE.small)
  expect(sent[1]?.system).not.toContain(THREE.medium)
  expect(await traced()).toContain(
    `personality: ${String(THREE.medium.length)} characters (medium), then ${String(THREE.small.length)} characters (small) sent`,
  )
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

test('core says which channel a task is being read in, and nothing for the window', async () => {
  // Improvement 9. Core knows one thing about where an answer will be read — which plugin
  // started the task — so that is what it says; what the word means is the answering plugin's
  // business. The window sends nothing at all, because *the window* is not a channel anybody
  // bound a personality to, it is the absence of one.
  // Line endings normalised: git hands a Windows checkout CRLF, and the patterns below span
  // line breaks (`12-version-in-step.test.ts` documents the same trap).
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'serve.ts'), 'utf8').replace(/\r\n/g, '\n')
  expect(source).toMatch(/async function personality\(channel\?: string\)/)
  expect(source).toMatch(/channel === undefined \? undefined : \{ channel \}/)
  // The plugin path names its own plugin; the window path calls it with nothing.
  expect(source).toMatch(/await personality\(pluginId\)/)
  expect(source).toMatch(/const chosen = await personality\(\)/)
})
