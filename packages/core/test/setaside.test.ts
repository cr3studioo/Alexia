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
 * **Set aside, and back without a restart** (`model_plan.md` §4 B, D161), over `/api/chat`.
 *
 * `health.test.ts` holds the rules. What only this reaches is the whole loop: `send()` writing
 * each try to the record, `world()` judging the record on the next question, and a key saved
 * between two questions reaching the judgement — because the keychain is read on every ask.
 *
 * Two keyless providers. `floor` wants a key for two of its models and would answer the third;
 * `spare` answers everything.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-setaside-'))

/** `model@key-or-none`, in the order asked. */
const asked: string[] = []
/** Models that are rate-limited right now. */
let busy = new Set<string>()
const models: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const { model } = JSON.parse(raw) as { model: string }
    const keyed = request.headers.authorization !== undefined
    asked.push(`${model}@${keyed ? 'key' : 'none'}`)
    if (busy.has(model)) {
      response.writeHead(429, { 'content-type': 'text/plain' })
      response.end('slow down')
      return
    }
    if (!keyed && (model === 'floor/a' || model === 'floor/b')) {
      response.writeHead(401, { 'content-type': 'text/plain' })
      response.end('Missing API key')
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: `from ${model}` }, finish_reason: 'stop' }] })}\n\n` +
        `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
    )
  })
})
await new Promise<void>((resolve) => models.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(models.address() as AddressInfo).port}/v1`

const floor: Provider = { id: 'floor', name: 'Floor', baseUrl: base, auth: 'optional', rpm: 1000, rpd: 1000 }
const spare: Provider = { id: 'spare', name: 'Spare', baseUrl: base, auth: 'optional', rpm: 1000, rpd: 1000 }

const row = (id: string, provider: string, weekly: number): Record<string, unknown> => ({
  id,
  name: id,
  provider,
  tier: 'T1',
  priceIn: 0,
  priceOut: 0,
  context: 262_144,
  supportsTools: true,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'unknown',
  weekly,
})
// The two that want a key are the busiest, so Automatic asks them first; `floor/c` is below
// `spare/s`, so the first question never reaches it.
noPolling(root, [row('floor/a', 'floor', 900), row('floor/b', 'floor', 800), row('spare/s', 'spare', 700), row('floor/c', 'floor', 600)])

const secrets = memorySecrets()
const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: join(root, 'extensions'),
  secrets,
  providers: [floor, spare],
  local: false,
})

afterAll(async () => {
  await alexia.close()
  models.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** One question, read to the end. */
const chat = async (text: string): Promise<string> =>
  (
    await fetch(new URL('/api/chat', alexia.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
      body: JSON.stringify({ text }),
    })
  ).text()

test('a keyless provider that refused two models is skipped, and a saved key brings every one of them back', async () => {
  asked.length = 0
  expect(await chat('what is on today')).toContain('from spare/s')
  expect(asked).toEqual(['floor/a@none', 'floor/b@none', 'spare/s@none'])
  // Every try is in the record, the answer included.
  expect(alexia.store.tries().map((one) => `${one.model} ${one.outcome} ${one.source}`)).toEqual([
    'floor/a needs-key chat',
    'floor/b needs-key chat',
    'spare/s answered chat',
  ])

  // Two of Floor's models wanted a key, so every Floor model is set aside — `floor/c` included,
  // though it was never asked — and the next question goes straight to the one that answers.
  asked.length = 0
  expect(await chat('and tomorrow')).toContain('from spare/s')
  expect(asked).toEqual(['spare/s@none'])

  // A key, saved between two questions. No restart: the next question is judged with it, and
  // every Floor model is back in the plan. `floor/a` and `floor/b` still sink for the hour on
  // their refusals (D159), below `floor/c` and `spare/s` — so with those two busy, the walk
  // reaches `floor/a`, on the key, set aside no longer.
  await secrets.set(CORE, keyOf(floor), 'sk-floor')
  busy = new Set(['floor/c', 'spare/s'])
  asked.length = 0
  expect(await chat('and the day after')).toContain('from floor/a')
  expect(asked).toEqual(['floor/c@key', 'spare/s@none', 'floor/a@key'])
  busy = new Set()
}, 30_000)
