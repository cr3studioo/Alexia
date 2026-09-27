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
import { NAME_LONGEST, serve, type Serving } from '../src/serve.js'

/**
 * **The chat, over the real wire**: what Stop keeps, one answer at a time, and the name she
 * was given reaching the model.
 *
 * One scripted model. `say` streams its words and ends; `hang` streams its words and then
 * holds the request open, which is an answer somebody is watching being written — the only
 * moment Stop and a second send can happen in.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-chatting-'))

type Turn = { say: string } | { hang: string }
let script: Turn[] = []
/** The system line of every request the model was sent, in order. */
const systems: string[] = []
/** Every request's messages, in order, as the model saw them. */
const seen: { role: string; content: unknown }[][] = []

const chunk = (content: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
const models: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (piece: Buffer) => (raw += piece.toString()))
  request.on('end', () => {
    const body = JSON.parse(raw) as { messages: { role: string; content: unknown }[] }
    seen.push(body.messages)
    const first = body.messages[0]
    systems.push(first?.role === 'system' ? String(first.content) : '')
    const turn = script.shift() ?? { say: 'done' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if ('hang' in turn) {
      // Written, flushed, and then nothing — until the client goes away.
      response.write(chunk(turn.hang))
      return
    }
    response.end(
      chunk(turn.say) +
        `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
    )
  })
})
await new Promise<void>((resolve) => models.listen(0, '127.0.0.1', resolve))

const stub: Provider = {
  id: 'stub',
  name: 'Stub',
  baseUrl: `http://127.0.0.1:${(models.address() as AddressInfo).port}/v1`,
  rpm: 1000,
  rpd: 1000,
}
noPolling(root, [
  {
    id: 'stub/one',
    name: 'Stub One',
    provider: 'stub',
    tier: 'T1',
    priceIn: 0,
    priceOut: 0,
    context: 32_768,
    supportsTools: true,
    modality: ['text'],
    nsfwOk: 'unknown',
    trainsOnYourData: 'unknown',
  },
])

const secrets = memorySecrets()
await secrets.set(CORE, keyOf(stub), 'sk-stub')
const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  secrets,
  providers: [stub],
  local: false,
})

afterAll(async () => {
  await alexia.close()
  models.closeAllConnections()
  models.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const call = (path: string, body: unknown): Promise<Response> =>
  fetch(new URL(path, alexia.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
    body: JSON.stringify(body),
  })

/** Send a message and read the whole answer stream as frames. */
const chat = async (text: string): Promise<Record<string, unknown>[]> => {
  const response = await call('/api/chat', { text })
  expect(response.status).toBe(200)
  const raw = await response.text()
  return raw
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>)
}

/** Wait until the model has been asked `n` times in all. */
const asked = async (n: number): Promise<void> => {
  for (let i = 0; i < 200 && seen.length < n; i++) await new Promise((resolve) => setTimeout(resolve, 20))
  expect(seen.length).toBeGreaterThanOrEqual(n)
}

const open = (): number => alexia.store.sessions()[0]!.id

test('Stop keeps what was written, marked stopped, and never sends it to a model again', async () => {
  script = [{ hang: 'The first half of an answer' }]
  const before = seen.length
  const answering = call('/api/chat', { text: 'tell me a long story' })
  await asked(before + 1)
  // Give the words a moment to cross from the model to the loop.
  await new Promise((resolve) => setTimeout(resolve, 100))
  await call('/api/stop', {})
  await (await answering).text()

  const last = alexia.store.history(open()).at(-1)
  expect(last).toMatchObject({ role: 'assistant', content: 'The first half of an answer', stopped: true })

  // The next question is answered without the half answer in front of it.
  script = [{ say: 'Here you go.' }]
  await chat('something else')
  const sent = seen.at(-1)!
  expect(sent.some((turn) => turn.content === 'The first half of an answer')).toBe(false)
}, 30_000)

test('a second message while one is being answered is refused with a sentence, and the next one is not', async () => {
  script = [{ hang: 'Still going' }]
  const before = seen.length
  const first = call('/api/chat', { text: 'the first' })
  await asked(before + 1)

  const second = await call('/api/chat', { text: 'the second' })
  expect(second.status).toBe(423)
  expect(await second.json()).toEqual({ ok: false, busy: true, said: 'Alexia is still answering — wait for her or press Stop.' })

  await call('/api/stop', {})
  await (await first).text()

  // Released however the first one ended.
  script = [{ say: 'Back again.' }]
  const frames = await chat('the third')
  expect(frames.some((frame) => frame.done !== undefined)).toBe(true)
}, 30_000)

test('the name she was given is the name the model is told, and a very long one is refused', async () => {
  const saved = await call('/api/setup', { name: 'Nova' })
  expect(saved.status).toBe(200)
  script = [{ say: 'Hi.' }]
  await chat('who are you?')
  expect(systems.at(-1)).toMatch(/^You are Nova, an assistant/)

  const long = await call('/api/setup', { name: 'N'.repeat(NAME_LONGEST + 1) })
  expect(long.status).toBe(400)
  expect(((await long.json()) as { said: string }).said).toMatch(/too long/)
  expect(alexia.store.kvGet(CORE, 'display_name')).toBe('Nova')
}, 30_000)

test('the chats list carries the moment as a number, for the screen to write in its own way', async () => {
  const rows = (await (await call('/api/rows', { key: 'chats' })).json()) as { rows: Record<string, unknown>[] }
  const row = rows.rows[0]!
  expect(typeof row.at).toBe('number')
  expect(typeof row.when).toBe('string')
}, 30_000)
