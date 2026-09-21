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

/**
 * **Who is answering, over the wire** (improvements 8 and 10): the chip, *That wasn't her*,
 * and the difference between a plugin *promising* them and *binding* them.
 *
 * `nother.test.ts` holds the shape of the code. What only this reaches is the behaviour that
 * shape exists for: a plugin whose manifest lists `persona.not_her` with nothing in use draws
 * no button, the answer is kept between state reads and asked again when the plugin changes
 * what it binds, and a line typed after the press lands on the answer that was pressed.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-speaking-'))
const from = mkdtempSync(join(tmpdir(), 'alexia-speaker-'))

const models: Server = createServer((request, response) => {
  request.resume()
  request.on('end', () => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'the answer' }, finish_reason: 'stop' }] })}\n\n` +
        `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
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

mkdirSync(join(from, 'speaker'), { recursive: true })
writeFileSync(
  join(from, 'speaker', 'plugin.json'),
  JSON.stringify({
    manifest_version: 1,
    id: 'speaker',
    name: 'Speaker',
    summary: 'Promises who is answering, and binds it only while something is in use.',
    version: '0.1.0',
    license: 'AGPL-3.0-only',
    entry: { run: 'node', args: [join(import.meta.dirname, 'fixtures', 'speaker.js')] },
    alexia_protocol: 10,
    mcp_protocol: '2025-11-25',
    provides: ['persona.in_use', 'persona.not_her'],
    settings: [
      { type: 'action', key: 'use', label: 'Use', tool: 'use' },
      { type: 'action', key: 'stop', label: 'Stop', tool: 'stop' },
      { type: 'action', key: 'marks', label: 'Marks', tool: 'marks' },
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

const state = async (): Promise<{ character?: string; notHer?: boolean }> =>
  (await (await fetch(new URL('/api/state', alexia.url), { headers: { 'x-alexia-token': alexia.token } })).json()) as {
    character?: string
    notHer?: boolean
  }

// `approved`, because `use` and `stop` change something and the gate asks first — the same
// answer `asking.test.ts` gives its own buttons.
const press = (key: string): Promise<Record<string, unknown>> => post('/api/action', { plugin: 'speaker', key, approved: true })

async function say(text: string): Promise<void> {
  const response = await fetch(new URL('/api/chat', alexia.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
    body: JSON.stringify({ text }),
  })
  await response.text()
}

/** A tool-list change reaches core as a notification, so the next read may be a moment behind it. */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read()
  for (let tries = 0; tries < 50 && !done(value); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    value = await read()
  }
  return value
}

test('a promise with nothing bound behind it draws no button and no chip', async () => {
  expect((await post('/api/plugin', { id: 'speaker', action: 'enable' })).ok).toBe(true)
  // The manifest lists both. Nothing is in use, so neither is bound — and reading the promise
  // drew *That wasn't her* over a press nothing would keep.
  const now = await state()
  expect(now.notHer).toBe(false)
  expect(now.character).toBeUndefined()
})

test('binding them is noticed, and so is letting go of them', async () => {
  expect((await press('use')).ok).toBe(true)
  const using = await eventually(state, (one) => one.notHer === true)
  expect(using).toMatchObject({ character: 'Chief of staff', notHer: true })

  expect((await press('stop')).ok).toBe(true)
  const stopped = await eventually(state, (one) => one.notHer === false)
  expect(stopped.notHer).toBe(false)
  expect(stopped.character).toBeUndefined()
})

test('a press nothing keeps is not reported as kept', async () => {
  await say('who are you')
  // Nothing is in use, so nothing binds `persona.not_her`: the press still succeeds, and says
  // that nothing heard it rather than letting the screen say *Noted*.
  expect(await post('/api/not-her', {})).toEqual({ ok: true, heard: false })
})

test('a line typed after the press lands on the answer that was pressed', async () => {
  await press('use')
  await eventually(state, (one) => one.notHer === true)
  await say('first question')
  expect(await post('/api/not-her', {})).toEqual({ ok: true, heard: true })
  // The conversation carries on while the box is open under the first answer…
  await say('second question')
  // …and the line typed into that box is still about the first one.
  expect(await post('/api/not-her', { said: 'Just answer.' })).toEqual({ ok: true, heard: true })

  const marks = JSON.parse(String((await press('marks')).said)) as { answer: string; asked?: string; said?: string }[]
  expect(marks).toHaveLength(2)
  expect(marks[0]).toMatchObject({ asked: 'first question' })
  expect(marks[1]).toMatchObject({ asked: 'first question', said: 'Just answer.' })
  expect(marks[1]?.answer).toBe(marks[0]?.answer)
  await press('stop')
})
