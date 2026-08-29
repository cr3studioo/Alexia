// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { keyOf, PROVIDERS, type Provider } from '../src/provider.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'

/**
 * M7-5's acceptance: **a task started somewhere other than the window, that needs
 * permission, asks there — and the answer reaches the same ruling the app would produce.**
 *
 * The plugin here is a fixture rather than `plugins/telegram`, and deliberately: what is
 * being held still is the *contract* — a plugin saying *use my tools, and ask me when you
 * must*, and providing somewhere for the asking to happen. Telegram is one caller of that
 * shape; this proves the shape. Its own half — buttons, and a token that cannot outgrow 64
 * bytes — is in `plugins/telegram/test/asking.test.js`.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-asking-'))
const from = mkdtempSync(join(tmpdir(), 'alexia-asker-'))

/** A scripted model, on a provider row pushed into the table core reads. */
let script: ({ call: string } | { say: string })[] = []
const served: string[] = []
const models: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    served.push(raw)
    const turn = script.shift() ?? { say: 'done' }
    const delta =
      'call' in turn ?
        { tool_calls: [{ index: 0, id: 'c1', function: { name: turn.call, arguments: '{}' } }] }
      : { content: turn.say }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n` +
        `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
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
PROVIDERS.push(stub)

mkdirSync(join(root, 'cache'), { recursive: true })
writeFileSync(
  join(root, 'cache', 'models.json'),
  JSON.stringify({
    fetchedAt: Date.now(),
    models: [
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
    ],
  }),
)

// The plugin, staged the way `staged.ts` stages a real one: the manifest here, the code
// where it was written, so the entry is an absolute path.
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
      { type: 'action', key: 'plain', label: 'Just ask', tool: 'plain' },
      { type: 'action', key: 'asked', label: 'What was asked', tool: 'asked' },
      { type: 'action', key: 'answer_no', label: 'Say no next time', tool: 'answer_no' },
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
})

afterAll(async () => {
  await alexia.close()
  models.close()
  PROVIDERS.splice(PROVIDERS.indexOf(stub), 1)
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
  post('/api/action', { plugin: 'asker', key, approved: true })

test('a plugin that says nothing about tools gets a completion, as it always did', async () => {
  expect((await post('/api/plugin', { id: 'asker', action: 'enable' })).ok).toBe(true)

  // Not this test's subject, but the thing that must not have changed: a plain `sampling`
  // call is one completion, no loop, no gate. The flag is opt-in and the default is what it
  // was before the flag existed, which is why this needed no revision of the contract.
  script = [{ say: 'plainly' }]
  served.length = 0
  const said = await press('plain')
  expect(said.ok, String(said.said)).toBe(true)
  expect(String(said.said)).toContain('plainly')

  // One request, and no tool list in it. The loop was never entered, so there was nothing
  // for the gate to stop and nowhere a question could have come from.
  expect(served).toHaveLength(1)
  expect(served[0]).not.toContain('asker__wipe')
  expect(JSON.parse(served[0]!)).not.toHaveProperty('tools')
}, 30_000)

test('a task started by a plugin asks that plugin, and the yes lets the step run', async () => {
  // The model plans a destructive step, which the default mode (`risky`) stops to ask about.
  script = [{ call: 'asker__wipe' }, { say: 'tidied' }]
  const started = await press('go')

  expect(started.ok, String(started.said)).toBe(true)
  expect(String(started.said)).toContain('tidied')

  // The question went to the plugin, in core's own words — the same sentence the window
  // would have shown, because it is the same `rule()` and the same gate.
  const asked = await press('asked')
  expect(String(asked.said)).toContain('asker__wipe')
  expect(String(asked.said)).toContain('changes or deletes something')
}, 30_000)

test('and a no is a no, which is what nothing providing the asking already meant', async () => {
  await press('answer_no')
  script = [{ call: 'asker__wipe' }, { say: 'left it alone' }]
  const started = await press('go')

  expect(started.ok, String(started.said)).toBe(true)
  expect(String(started.said)).toContain('left it alone')

  // The refusal reached the model as an observation rather than an exception, which is what
  // lets a task plan around it — the same thing a no from the window does.
  const seen = served.join('\n')
  expect(seen).toContain('The user did not approve it')
}, 30_000)
