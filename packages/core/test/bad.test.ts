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
 * `model_plan.md` §4 I's acceptance: **a press asks again and the model that answered is not
 * asked; two presses in 30 days tag it and move it below untagged models** (D161).
 *
 * A script can see an error and cannot see a wrong answer, so this is the one signal about
 * quality that comes from a person.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-bad-'))

/** Which model each request went to, and every body a model received. */
const asked: string[] = []
const bodies: string[] = []
const models: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const { model } = JSON.parse(raw) as { model: string }
    asked.push(model)
    bodies.push(raw)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const words = model === 'model/first' ? 'a confidently wrong answer' : `an answer from ${model}`
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: words }, finish_reason: 'stop' }] })}\n\n` +
        `data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
    )
  })
})
await new Promise<void>((resolve) => models.listen(0, '127.0.0.1', resolve))

const stub: Provider = { id: 'stub', name: 'Stub', baseUrl: `http://127.0.0.1:${String((models.address() as AddressInfo).port)}/v1`, rpm: 1000, rpd: 1000 }
const row = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: id,
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
  row('model/first', { weekly: 9_000 }),
  row('model/second', { weekly: 10 }),
  row('model/paid', { tier: 'T2', priceIn: 1, priceOut: 2, context: 128_000 }),
])

const secrets = memorySecrets()
await secrets.set(CORE, keyOf(stub), 'sk-stub')
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

async function chat(body: Record<string, unknown>): Promise<{ status: number; said: string }> {
  const response = await fetch(new URL('/api/chat', alexia.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
    body: JSON.stringify(body),
  })
  const said = (await response.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>)
    .flatMap((event) => (typeof event.delta === 'string' ? [event.delta] : []))
    .join('')
  return { status: response.status, said }
}

test('a press asks again without the model that answered, and the bad answer never goes back to a model', async () => {
  expect((await chat({ text: 'what is two and two' })).said).toBe('a confidently wrong answer')

  asked.length = 0
  bodies.length = 0
  expect((await chat({ again: true, bad: {} })).said).toBe('an answer from model/second')
  expect(asked).toEqual(['model/second'])
  expect(bodies.join('\n')).not.toContain('confidently wrong')

  // Recorded as a person's press on that model on that provider.
  expect(alexia.store.tries().filter((one) => one.outcome === 'bad-answer').map((one) => `${one.model}@${one.provider} ${one.source}`)).toEqual([
    'model/first@stub person',
  ])
  // Still on the page, marked.
  const state = (await (await fetch(new URL('/api/state', alexia.url), { headers: { 'x-alexia-token': alexia.token } })).json()) as {
    messages: { role: string; content: string; bad?: boolean }[]
  }
  expect(state.messages.filter((turn) => turn.role === 'assistant').map((turn) => [turn.content, turn.bad === true])).toEqual([
    ['a confidently wrong answer', true],
    ['an answer from model/second', false],
  ])

  // The next question goes back to the ranking as it was: one press is the question's fault as
  // often as the model's.
  asked.length = 0
  expect((await chat({ text: 'and three and three' })).said).toBe('a confidently wrong answer')
}, 30_000)

test('two presses in 30 days tag the model and move it below the models nobody doubts', async () => {
  expect((await chat({ again: true, bad: {} })).said).toBe('an answer from model/second')
  const rows = ((await post('/api/rows', { key: 'models' })).rows ?? []) as { group: string; id: string; tags: { says: string }[] }[]
  const automatic = rows.filter((one) => one.group === 'Automatic, free')
  expect(automatic.map((one) => one.id)).toEqual(['stub\nmodel/second', 'stub\nmodel/first'])
  expect(automatic[1]?.tags.map((tag) => tag.says)).toContain('gave bad answers')

  // Nothing left to mark once the latest answer is marked and nothing has answered since.
  await post('/api/action', { key: 'new_chat' })
  expect((await chat({ again: true, bad: {} })).status).toBe(409)
}, 30_000)

test('with the paid switch on, the question is asked again above the tier of the model marked bad', async () => {
  expect((await post('/api/action', { key: 'set_cross', row: 'on:1' })).ok).toBe(true)
  expect((await chat({ text: 'what is four and four' })).said).toBe('an answer from model/second')
  asked.length = 0
  expect((await chat({ again: true, bad: {} })).said).toBe('an answer from model/paid')
  expect(asked).toEqual(['model/paid'])
}, 30_000)
