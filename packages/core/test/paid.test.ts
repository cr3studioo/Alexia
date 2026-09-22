// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { noPolling } from './staged.js'
import { keyOf, type Provider } from '../src/provider.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'
import { caps, setCaps } from '../src/usage.js'

/**
 * `model_plan.md` §4 H's acceptance: **crossing into paid**, over `/api/chat` (D160, D161).
 *
 * The paid switch off: when the free models are done and a paid one would answer, the work pauses
 * and nothing is billed; *Allow switching to a paid model* answers from the paid one and covers the
 * conversation. The switch on: paid answers within the day's amount, and stops when it is spent.
 * A task from a phone asks on the phone, and gives up after its wait.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-paid-'))
const from = mkdtempSync(join(tmpdir(), 'alexia-paid-plugin-'))

/** Models that are rate-limited right now. */
let busy = new Set<string>()
/** Which model each request went to. */
const asked: string[] = []
const models: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const { model } = JSON.parse(raw) as { model: string }
    asked.push(model)
    if (busy.has(model)) {
      response.writeHead(429, { 'content-type': 'text/plain' })
      // A day's allowance spent, not a host busy for a second: a 429 asking again cannot clear.
      response.end('slow down: free-models-per-day')
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: `from ${model}` }, finish_reason: 'stop' }] })}\n\n` +
        `data: ${JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 1000 } })}\n\ndata: [DONE]\n\n`,
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
// The paid model reads more than the free one, so it is worth buying rather than a sidegrade.
noPolling(root, [row('free/one', 'Free One'), row('paid/one', 'Paid One', { tier: 'T2', priceIn: 1, priceOut: 2, context: 128_000 })])

mkdirSync(join(from, 'asker'), { recursive: true })
writeFileSync(
  join(from, 'asker', 'plugin.json'),
  JSON.stringify({
    manifest_version: 1,
    id: 'asker',
    name: 'Asker',
    summary: 'Starts a task the way a message from a phone would.',
    version: '0.1.0',
    license: 'AGPL-3.0-only',
    entry: { run: 'node', args: [join(import.meta.dirname, 'fixtures', 'asker.js')] },
    alexia_protocol: 2,
    mcp_protocol: '2025-11-25',
    provides: ['ask.confirm'],
    settings: [
      { type: 'action', key: 'go', label: 'Start one', tool: 'go' },
      { type: 'action', key: 'asked', label: 'What was asked', tool: 'asked' },
      { type: 'action', key: 'answer_yes', label: 'Say yes next time', tool: 'answer_yes' },
      { type: 'action', key: 'answer_never', label: 'Never answer', tool: 'answer_never' },
    ],
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
  allowWaitMs: 500,
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

/** One POST to `/api/chat`, and every frame the screen was sent. */
async function chat(body: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const response = await fetch(new URL('/api/chat', alexia.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
    body: JSON.stringify(body),
  })
  return (await response.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>)
}
const said = (events: Record<string, unknown>[]): string => events.flatMap((event) => (typeof event.delta === 'string' ? [event.delta] : [])).join('')

test('switch off: the free models done, the answer pauses and nothing is billed; Allow answers from paid for the conversation', async () => {
  busy = new Set(['free/one'])
  asked.length = 0
  const paused = await chat({ text: 'what is on today' })
  // What happened to the free one, said beside *Allow* — not a fixed *used up*.
  expect(paused.find((event) => 'paused' in event)).toEqual({ paused: 'Free One is rate-limited right now.', daily: 0 })
  expect(asked).toEqual(['free/one'])
  expect(alexia.store.spend(0)).toBe(0)

  // Allow, with the day's amount typed beside the button because there was none.
  asked.length = 0
  const allowed = await chat({ again: true, allow: { daily: 1 } })
  expect(said(allowed)).toBe('from paid/one')
  expect(allowed.some((event) => 'paused' in event)).toBe(false)
  expect(caps(alexia.store).daily).toBe(1)
  // Said before the charge, in its own place.
  expect(allowed.find((event) => 'paid' in event)).toBeDefined()

  // The same conversation does not pause again.
  const next = await chat({ text: 'and tomorrow' })
  expect(said(next)).toBe('from paid/one')

  // A new conversation is a new question about money.
  await post('/api/action', { key: 'new_chat' })
  const fresh = await chat({ text: 'and the day after' })
  expect(fresh.find((event) => 'paused' in event)).toEqual({ paused: 'Free One is rate-limited right now.', daily: 1 })
}, 30_000)

test('switch on: paid answers once the free ones are done, and stops when the day’s amount is spent', async () => {
  const on = await post('/api/action', { key: 'set_cross', row: 'on:1' })
  expect(on.said).toBe('On. Paid models will be used once the free ones are done, up to $1.00 a day.')
  const state = (await (await fetch(new URL('/api/state', alexia.url), { headers: { 'x-alexia-token': alexia.token } })).json()) as { cross?: boolean }
  expect(state.cross).toBe(true)

  await post('/api/action', { key: 'new_chat' })
  busy = new Set(['free/one'])
  expect(said(await chat({ text: 'what is on today' }))).toBe('from paid/one')

  // The day's dollar spent: it stops as the allowance always did, and does not pause.
  alexia.store.recordUsage({ model: 'paid/one', provider: 'stub', tokensIn: 0, tokensOut: 0, cost: 1.5 })
  const spent = await chat({ text: 'once more' })
  expect(spent.some((event) => 'paused' in event)).toBe(false)
  expect(String(spent.find((event) => 'error' in event)?.error)).toContain("today's $1.00 for paid models is spent")

  expect((await post('/api/action', { key: 'set_cross', row: 'off' })).ok).toBe(true)
  expect(caps(alexia.store)).toMatchObject({ cross: false, daily: 1 })
}, 30_000)

test('a task from a phone asks on the phone: yes answers from paid, and no answer stops it after the wait', async () => {
  expect((await post('/api/plugin', { id: 'asker', action: 'enable' })).ok).toBe(true)
  busy = new Set(['free/one'])
  // The switch off, and a day's amount the last test did not already spend.
  setCaps(alexia.store, { ...caps(alexia.store), cross: false, daily: 5 })

  await post('/api/action', { plugin: 'asker', key: 'answer_yes' })
  const allowed = await post('/api/action', { plugin: 'asker', key: 'go', approved: true })
  expect(String(allowed.said)).toContain('from paid/one')
  expect(String((await post('/api/action', { plugin: 'asker', key: 'asked' })).said)).toBe(
    'Free One is rate-limited right now. Allow switching to a paid model, up to $5.00 today?',
  )

  // A new conversation for the phone, and nobody answers this time.
  alexia.store.kvDelete(CORE, 'chat:asker')
  await post('/api/action', { plugin: 'asker', key: 'answer_never' })
  const unanswered = await post('/api/action', { plugin: 'asker', key: 'go', approved: true })
  expect(String(unanswered.said)).toContain('Nobody allowed a paid model within ten minutes, so this stopped.')
}, 30_000)
