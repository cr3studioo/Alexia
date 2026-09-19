// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { noPolling } from './staged.js'
import { keyOf, type Provider } from '../src/provider.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'

/**
 * `plan-personality.md` order of work step 3: **was it sent, and how much of it?**
 *
 * The bug was reported as *the personality is not being sent* and it was being sent — 221
 * characters of a document that should have run to thousands, because Adapt had saved half
 * one (D157). Nothing on the screen could tell *none* from *a stub*, so the first guess was
 * the wrong one and stayed the wrong one for a while.
 *
 * This is the end of that: a real run, through `serve()`, with a plugin that answers
 * `persona.personality`, and the number read back off the trace panel's own detail view.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-personality-trace-'))

/**
 * The smallest plugin that answers the capability, read from the repo rather than copied to
 * a temporary folder: it imports the MCP server package, so it has to run somewhere that can
 * resolve `node_modules` — which is the same reason `supervisor.test.ts` runs its fixture in
 * place.
 */
const extensions = join(import.meta.dirname, 'fixtures', 'plugins')

/**
 * What the plugin hands back, from the one file both it and this test read.
 *
 * Trimmed, because `personality()` trims what a plugin says before anything sees it, so the
 * trailing newline in the file is not part of what reached the model.
 */
const DOC = readFileSync(join(extensions, 'voice', 'doc.txt'), 'utf8').trim()

const models: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
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

test('the trace says how long the personality was, so *was it sent* is readable', async () => {
  await post('/api/plugin', { id: 'voice', action: 'enable' })
  await say('who are you')

  const listed = (await post('/api/rows', { key: 'activity' })) as { rows?: { id: string }[] }
  const id = listed.rows?.[0]?.id
  expect(id).toBeTypeOf('string')

  const opened = (await post('/api/detail', { key: 'activity', row: id })) as { text?: string }
  // The number, and the unit. 221 against a description somebody knows ran to thousands is
  // the whole story, and a bare *sent* cannot tell it.
  // The length, and which of §2's three it was — this fixture's plugin offers one document,
  // so every model gets it and the size reads as `high` (`sized()`'s fallback).
  expect(opened.text).toContain(`personality: ${String(DOC.length)} characters (high) sent`)
})

test('with nothing answering the capability, the same line says none sent', async () => {
  // Not the absence of a line: *none sent* is the reported fault, and it has to be legible
  // as a finding rather than as something the trace forgot to mention.
  await post('/api/plugin', { id: 'voice', action: 'disable' })
  await say('and now')

  const listed = (await post('/api/rows', { key: 'activity' })) as { rows?: { id: string }[] }
  const opened = (await post('/api/detail', { key: 'activity', row: listed.rows?.[0]?.id })) as { text?: string }
  expect(opened.text).toContain('personality: none sent')
})
