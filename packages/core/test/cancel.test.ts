// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type ServerResponse } from 'node:http'
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
 * `model_plan.md` §4 A's acceptance: **when a plugin gives up, core stops** (D160).
 *
 * The personality adapter waits 110 s for a model and then shows a refusal. Core used to go on
 * down the plan behind it — the SDK's cancel reached the handler and was dropped there — so the
 * next rung was asked, and billed, for an answer nobody was waiting for any more.
 *
 * Two providers: the first accepts a request and never answers, the second would answer at
 * once. The first's patience is two seconds, so without the cancel the second is asked a second
 * after the plugin has given up — which is the window this watches.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-cancel-'))
const from = mkdtempSync(join(tmpdir(), 'alexia-impatient-'))

/** Which model each request was for, in order. */
const served: string[] = []
/** Requests held open by the silent provider, released when the suite ends. */
const held: ServerResponse[] = []
const models = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const { model } = JSON.parse(raw) as { model: string }
    served.push(model)
    if (model === 'silent/one') {
      held.push(response)
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'here' }, finish_reason: 'stop' }] })}\n\n` +
        `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
    )
  })
})
await new Promise<void>((resolve) => models.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(models.address() as AddressInfo).port}/v1`

const silent: Provider = { id: 'silent', name: 'Silent', baseUrl: base, rpm: 1000, rpd: 1000, timeoutMs: 2000 }
const stub: Provider = { id: 'stub', name: 'Stub', baseUrl: base, rpm: 1000, rpd: 1000 }

const row = (id: string, provider: string, weekly: number) => ({
  id,
  name: id,
  provider,
  tier: 'T1',
  priceIn: 0,
  priceOut: 0,
  context: 32_768,
  supportsTools: true,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'unknown',
  // The silent one is the busier model, so Automatic asks it first.
  weekly,
})
noPolling(root, [row('silent/one', 'silent', 9_000), row('stub/two', 'stub', 1)])

mkdirSync(join(from, 'impatient'), { recursive: true })
writeFileSync(
  join(from, 'impatient', 'plugin.json'),
  JSON.stringify({
    manifest_version: 1,
    id: 'impatient',
    name: 'Impatient',
    summary: 'Asks for the model and stops waiting after a second.',
    version: '0.1.0',
    license: 'AGPL-3.0-only',
    entry: { run: 'node', args: [join(import.meta.dirname, 'fixtures', 'impatient.js')] },
    alexia_protocol: 2,
    mcp_protocol: '2025-11-25',
    settings: [
      { type: 'action', key: 'briefly', label: 'Ask briefly', tool: 'briefly' },
      { type: 'action', key: 'task_briefly', label: 'Start a task briefly', tool: 'task_briefly' },
      { type: 'action', key: 'task_patiently', label: 'Start a task patiently', tool: 'task_patiently' },
    ],
  }),
)

const secrets = memorySecrets()
await secrets.set(CORE, keyOf(silent), 'sk-silent')
await secrets.set(CORE, keyOf(stub), 'sk-stub')
const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: from,
  secrets,
  providers: [silent, stub],
  local: false,
})

afterAll(async () => {
  for (const response of held) response.destroy()
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

const press = (key: string): Promise<Record<string, unknown>> =>
  post('/api/action', { plugin: 'impatient', key, approved: true })

/** Longer than the silent provider's patience, so a walk that went on would have reached the stub. */
const pastPatience = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2500))

expect((await post('/api/plugin', { id: 'impatient', action: 'enable' })).ok).toBe(true)

test('a plugin that stops waiting stops the walk: the next rung is never asked, and nothing is held against the first', async () => {
  served.length = 0

  expect(String((await press('briefly')).said)).toContain('gave up')
  await pastPatience()

  expect(served).toEqual(['silent/one'])
  // The silent provider did not fail: the plugin stopped asking. A try recorded here would sink
  // a model for somebody else's impatience, and count towards setting it aside (D161).
  expect(alexia.store.tries()).toEqual([])
}, 30_000)

test('and a task a plugin started stops with it, leaving room for the next one', async () => {
  served.length = 0
  expect(String((await press('task_briefly')).said)).toContain('gave up')
  await pastPatience()

  expect(served).toEqual(['silent/one'])
  expect(alexia.store.tries()).toEqual([])

  // The task ended rather than waiting out the provider, so the next one is not refused as
  // *already working on something* — and a plugin that does wait still gets the walk.
  served.length = 0
  const next = await press('task_patiently')
  expect(String(next.said)).toContain('here')
  expect(served).toEqual(['silent/one', 'stub/two'])
}, 30_000)
