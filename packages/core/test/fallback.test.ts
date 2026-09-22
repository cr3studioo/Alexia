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
 * **Three modes, three promises** (D155), over the real wire: what the screen is told when a
 * model fails, in each of the three.
 *
 * The router and the loop have their own suites. What only this can reach is the last yard —
 * that a stop in somebody's own choice reaches the screen marked as theirs, that *Use
 * Automatic for this answer* answers once without touching the setting, and that a stream
 * which died under a half-written bubble tells the screen to clear it.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-fallback-'))

/** What each model does when asked: answer, fail with a status, or die after a few words. */
let behave = new Map<string, number | 'dies'>()
const asked: string[] = []
/** Every request body a model received, as sent. */
const served: string[] = []
const models: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const { model } = JSON.parse(raw) as { model: string }
    asked.push(model)
    served.push(raw)
    const how = behave.get(model)
    if (typeof how === 'number') {
      response.writeHead(how, { 'content-type': 'text/plain' })
      // A 429 here is a day's allowance spent, which asking again cannot clear — not a host busy
      // for a second, which `send()` asks again for a few seconds before it moves on.
      response.end(how === 429 ? 'free-models-per-day' : 'no')
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (how === 'dies') {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Half of' } }] })}\n\n`)
      setTimeout(() => response.destroy(), 20)
      return
    }
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: `from ${model}` } }] })}\n\n` +
        `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
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

const row = (id: string, name: string): Record<string, unknown> => ({
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
})
noPolling(root, [row('stub/one', 'Stub One'), row('stub/two', 'Stub Two')])

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

/** One POST to `/api/chat`, and every frame the screen was sent. */
async function chat(body: Record<string, unknown>): Promise<{ status: number; events: Record<string, unknown>[] }> {
  const response = await fetch(new URL('/api/chat', alexia.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
    body: JSON.stringify(body),
  })
  const events = (await response.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>)
  return { status: response.status, events }
}

const pinsNow = async (): Promise<{ model?: string; order?: string[] }> =>
  ((await (await fetch(new URL('/api/state', alexia.url), { headers: { 'x-alexia-token': alexia.token } })).json()) as {
    pins: { model?: string; order?: string[] }
  }).pins

/** The questions in the conversation on screen, which is the newest one. */
const userTurns = (): number => {
  const session = alexia.store.sessions()[0]?.id
  return session === undefined ? 0 : alexia.store.history(session).filter((turn) => turn.role === 'user').length
}

// First in the file, because it needs `stub/one` to be Automatic's first choice: every test
// below leaves a failure of `stub/one` on this machine, and a model that just failed is not
// asked first again (D159).
test('Automatic whose first model dies mid-sentence tells the screen to clear it, then answers', async () => {
  behave = new Map([['stub/one', 'dies']])
  const { events } = await chat({ text: 'one more' })

  const kinds = events.flatMap((event) =>
    'delta' in event ? [`delta:${String(event.delta)}`]
    : 'restart' in event ? ['restart']
    : 'note' in event ? ['note']
    : 'switch' in event ? ['switch']
    : [],
  )
  // The switch is an event of its own since §4 G, not a note: the screen says it twice.
  expect(kinds).toEqual(['delta:Half of', 'restart', 'switch', 'delta:from stub/two'])
  expect(events.some((event) => 'error' in event)).toBe(false)
}, 30_000)

test('a switch is said once as an event, kept on the answer across a reload, and never sent to a model', async () => {
  // `stub/one` failed in the test above, so it is asked second now; make the first one refuse.
  behave = new Map([['stub/two', 429]])
  asked.length = 0
  served.length = 0
  const { events } = await chat({ text: 'what is on today' })

  const switches = events.filter((event) => 'switch' in event).map((event) => event.switch as Record<string, unknown>)
  expect(switches).toEqual([
    {
      from: ['Stub Two'],
      to: 'Stub One',
      reasons: ['Stub Two is rate-limited right now'],
      says: 'Stub Two is rate-limited right now — this answer is from Stub One.',
    },
  ])
  // Once: no note repeats it.
  expect(events.filter((event) => 'note' in event)).toEqual([])

  // Kept on the answer, which is what a reload draws.
  const state = (await (await fetch(new URL('/api/state', alexia.url), { headers: { 'x-alexia-token': alexia.token } })).json()) as {
    messages: { role: string; notes?: string[] }[]
  }
  expect(state.messages.at(-1)).toMatchObject({ role: 'assistant', notes: ['Stub Two is rate-limited right now — this answer is from Stub One.'] })

  // And the next question sends that conversation to a model without the note in it.
  behave = new Map()
  await chat({ text: 'and tomorrow' })
  expect(served.at(-1)).toBeDefined()
  expect(served.at(-1)).not.toContain('this answer is from')
}, 30_000)

test('a pinned model that fails stops, marked as the person’s choice, and Automatic answers once without changing it', async () => {
  alexia.store.kvSet(CORE, 'pins', { model: 'stub/one' })
  behave = new Map([['stub/one', 429]])
  asked.length = 0
  const before = userTurns()

  const stopped = await chat({ text: 'what is on today' })
  const error = stopped.events.find((event) => 'error' in event)
  expect(error).toEqual({ error: 'Stub One is rate-limited right now.', chosen: 'pinned' })
  // One model never falls back: the other one was never asked.
  expect(asked).toEqual(['stub/one'])

  const again = await chat({ again: true, automatic: true })
  expect(again.events.some((event) => 'error' in event)).toBe(false)
  expect(again.events.filter((event) => 'delta' in event).map((event) => event.delta)).toEqual(['from stub/two'])
  // Automatic remembers that the pin was rate-limited a moment ago, so it asks the other model
  // first rather than collecting the same 429 again (D159). The pin itself was asked anyway:
  // what failed here orders Automatic, and never refuses somebody's own choice.
  expect(asked.slice(1)).toEqual(['stub/two'])

  // **One answer, not a setting**: the pin is where the person left it, and the question was
  // asked again rather than written into the conversation a second time.
  expect((await pinsNow()).model).toBe('stub/one')
  expect(userTurns()).toBe(before + 1)

  // With the question answered there is nothing to ask again.
  expect((await chat({ again: true, automatic: true })).status).toBe(409)
  alexia.store.kvSet(CORE, 'pins', {})
}, 30_000)

test('a list that fails all the way down stops at its end, marked as a list', async () => {
  alexia.store.kvSet(CORE, 'pins', { order: ['stub/one'] })
  behave = new Map([['stub/one', 404]])
  asked.length = 0

  const stopped = await chat({ text: 'and tomorrow' })
  expect(stopped.events.find((event) => 'error' in event)).toEqual({
    error: 'Stub One is no longer offered by Stub.',
    chosen: 'sequence',
  })
  expect(asked).toEqual(['stub/one'])
  alexia.store.kvSet(CORE, 'pins', {})
}, 30_000)

