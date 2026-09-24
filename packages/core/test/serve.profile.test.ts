// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { noPolling } from './staged.js'
import { keyOf, type Provider } from '../src/provider.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'

/**
 * **`memory.profile`, end to end**: the one place core reads memory back.
 *
 * *Who am I?* came back *I don't know you* from a free model that never called recall. The fix
 * has two halves and both are asserted here as the model receives them, off the wire: a short
 * block of what the user asked to be known, read once per task through the capability, and one
 * floor line saying a memory exists. And the rule every capability core reaches for holds — a
 * memory having a bad day costs the prompt its block, never the answer.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-profile-'))
const extensions = join(import.meta.dirname, 'fixtures', 'remembering')

/** Every system turn a model was shown, in order. */
const shown: string[] = []

const models: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const body = JSON.parse(raw) as { messages: { role: string; content: string }[] }
    shown.push(body.messages.find((m) => m.role === 'system')?.content ?? '')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'You are Václav.' }, finish_reason: 'stop' }] })}\n\n` +
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
// `T1`, a third party: what it is sent goes through the egress redaction, which is the point.
noPolling(root, [
  {
    id: 'model/first',
    name: 'model/first',
    provider: 'stub',
    tier: 'T1',
    priceIn: 0,
    priceOut: 0,
    context: 32_768,
    supportsTools: true,
    modality: ['text'],
    nsfwOk: 'unknown',
    trainsOnYourData: 'unknown',
    weekly: 9_000,
  },
])

const secrets = memorySecrets()
await secrets.set(CORE, keyOf(stub), 'sk-stub')
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

/** One message typed into the window, and the system turn the model was shown for it. */
async function say(text: string): Promise<string> {
  shown.length = 0
  const response = await fetch(new URL('/api/chat', alexia.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
    body: JSON.stringify({ text }),
  })
  await response.text()
  expect(shown.length).toBeGreaterThan(0)
  return shown[0] ?? ''
}

/** The trace panel's own detail view of the latest run. */
async function traced(): Promise<string> {
  const listed = (await post('/api/rows', { key: 'activity' })) as { rows?: { id: string }[] }
  const opened = (await post('/api/detail', { key: 'activity', row: listed.rows?.[0]?.id })) as { text?: string }
  return opened.text ?? ''
}

const BLOCK = 'What you know about the user:\nName: Václav.\nLives in Prague.\nSpeaks Czech and English.'
const MEMORY = 'You have a long-term memory about this user.'

test('the profile reaches the model through the capability, city and all, with the memory line', async () => {
  await post('/api/plugin', { id: 'profiled', action: 'enable' })
  const system = await say('who am i?')

  expect(system).toContain(BLOCK)
  // A third-party model, so this went through `redact()` — and a city alone is not a location
  // that policy strips: it says who he is, not where he is at any moment.
  expect(system).not.toContain('[redacted]')
  expect(system).toContain(MEMORY)
  expect(await traced()).toContain(`profile: ${String(BLOCK.length - 'What you know about the user:\n'.length)} characters sent`)
})

test('a task started by a plugin with tools carries the same profile', async () => {
  // The Telegram path: `createMessage` with `alexia/tools`, which runs the same loop from
  // another door, and has to open it with the same facts.
  shown.length = 0
  const said = await post('/api/action', { plugin: 'profiled', key: 'phone', approved: true })
  expect(said.ok, String(said.said)).toBe(true)
  expect(shown[0]).toContain(BLOCK)
  expect(shown[0]).toContain(MEMORY)
  await post('/api/plugin', { id: 'profiled', action: 'disable' })
})

test('a memory having a bad day costs the block, never the answer', async () => {
  await post('/api/plugin', { id: 'profiled', action: 'disable' })
  await post('/api/plugin', { id: 'broken', action: 'enable' })
  const system = await say('and now?')

  // Answered, with the stock floor and no block — and above all no error text dressed up as a
  // fact about the user.
  expect(system).toContain('You are Alexia')
  expect(system).not.toContain('What you know about the user')
  expect(system).not.toContain('locked')
  // Nothing answers `memory.recall` here, so there is no memory to point at either.
  expect(system).not.toContain(MEMORY)
  expect(await traced()).toContain('profile: none sent')
  await post('/api/plugin', { id: 'broken', action: 'disable' })
})

test('with nothing providing it, the prompt and the trace are what they always were', async () => {
  await post('/api/plugin', { id: 'broken', action: 'disable' })
  const system = await say('hello')
  expect(system).not.toContain('What you know about the user')
  expect(system).not.toContain(MEMORY)
  expect(await traced()).not.toContain('profile:')
})
