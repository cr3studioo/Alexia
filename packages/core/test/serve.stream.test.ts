// SPDX-License-Identifier: AGPL-3.0-only
import { STREAM_META, type StreamFrame } from '@alexia/protocol'
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
 * **A plugin's answer, while it is written** (`alexia/stream`), over the real wire.
 *
 * A channel plugin used to get the finished answer and nothing before it, so a phone showed a
 * typing dot for as long as a slow model took and then everything at once. What is held still
 * here is the contract: a plugin that passes `onprogress` to `createMessage` gets the words on
 * its own token, gathered into a few frames, ahead of the result — and a plugin that does not
 * gets exactly what it always got. The gathering itself has its own suite, with a fake clock.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-stream-'))
const from = mkdtempSync(join(tmpdir(), 'alexia-streamed-'))

/** What the model does next: call a tool, say something a few characters at a time, or die mid-sentence. */
type Turn = { call: string } | { say: string[] } | { dies: string }
let script: Turn[] = []

const chunk = (content: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
const models: Server = createServer((request, response) => {
  request.resume()
  request.on('end', () => {
    const turn = script.shift() ?? { say: ['done'] }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if ('dies' in turn) {
      response.write(chunk(turn.dies))
      setTimeout(() => response.destroy(), 20)
      return
    }
    if ('call' in turn) {
      const delta = { tool_calls: [{ index: 0, id: 'c1', function: { name: turn.call, arguments: '{}' } }] }
      response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`)
      return
    }
    // A few characters at a time, the way a provider streams — which is what there is to gather.
    const parts = [...turn.say]
    const next = (): void => {
      const part = parts.shift()
      if (part === undefined) {
        response.end(`data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
        return
      }
      response.write(chunk(part))
      setTimeout(next, 2)
    }
    next()
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

mkdirSync(join(from, 'streamed'), { recursive: true })
writeFileSync(
  join(from, 'streamed', 'plugin.json'),
  JSON.stringify({
    manifest_version: 1,
    id: 'streamed',
    name: 'Streamed',
    summary: 'Asks for an answer and watches it being written.',
    version: '0.1.0',
    license: 'AGPL-3.0-only',
    entry: { run: 'node', args: [join(import.meta.dirname, 'fixtures', 'streamed.js')] },
    alexia_protocol: 2,
    mcp_protocol: '2025-11-25',
    settings: ['plain', 'silent', 'task', 'help', 'status'].map((key) => ({ type: 'action', key, label: key, tool: key })),
  }),
)

const secrets = memorySecrets()
await secrets.set(CORE, keyOf(stub), 'sk-stub')
const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: from,
  secrets,
  // Only the stub, and nothing from this machine — the same two lines `asking.test.ts` explains.
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

interface Seen {
  text: string
  meta: Record<string, unknown> | null
  frames: { progress: number; total?: number; _meta?: Record<string, unknown> }[]
  complaints: string[]
}

/** Press one of the fixture's buttons, and read back what its `createMessage` saw. */
async function press(key: string): Promise<Seen & { streamed: StreamFrame[] }> {
  const said = await post('/api/action', { plugin: 'streamed', key, approved: true })
  expect(said.ok, String(said.said)).toBe(true)
  const seen = JSON.parse(String(said.said)) as Seen
  return { ...seen, streamed: seen.frames.map((frame) => frame._meta?.[STREAM_META] as StreamFrame) }
}

/** The words the frames add up to, from the last restart on — what a draft would be showing. */
const joined = (frames: StreamFrame[]): string => {
  const from = frames.findLastIndex((frame) => frame.restart === true) + 1
  return frames
    .slice(from)
    .map((frame) => frame.delta ?? '')
    .join('')
}

test('a plugin that sent a progress token gets the words while they are written, ahead of the answer', async () => {
  expect((await post('/api/plugin', { id: 'streamed', action: 'enable' })).ok).toBe(true)

  const words = 'Twenty short pieces, written one at a time.'.match(/.{1,2}/g)!
  script = [{ say: words }]
  const seen = await press('plain')

  expect(seen.text).toBe(words.join(''))
  // Every frame is ours, on the plugin's own token, and counts up as MCP says progress must.
  expect(seen.streamed.every((frame) => frame !== undefined)).toBe(true)
  const progress = seen.frames.map((frame) => frame.progress)
  expect(progress).toEqual([...progress].sort((a, b) => a - b))
  expect(new Set(progress).size).toBe(progress.length)
  expect(progress[0]).toBe(1)
  // An answer does not know how long it will be, so no frame pretends to.
  expect(seen.frames.every((frame) => frame.total === undefined)).toBe(true)

  // The deltas, joined, are the answer — all of it arrived before the result did.
  expect(joined(seen.streamed)).toBe(seen.text)
  // Gathered rather than forwarded: fewer frames of words than pieces the model sent.
  const deltas = seen.streamed.filter((frame) => frame.delta !== undefined)
  expect(deltas.length).toBeGreaterThan(0)
  expect(deltas.length).toBeLessThan(words.length)
  // And what the wait was doing, by the stage names the window reads.
  expect(seen.streamed.map((frame) => frame.phase).filter(Boolean)).toContain('writing')
  expect(seen.complaints).toEqual([])
}, 30_000)

test('a plugin that sent no token is sent nothing, which is what it always got', async () => {
  script = [{ say: ['quietly', ' said'] }]
  const seen = await press('silent')
  expect(seen.text).toBe('quietly said')
  expect(seen.frames).toEqual([])
  // Not merely unrecorded: nothing arrived for the SDK to complain was addressed to nobody.
  expect(seen.complaints).toEqual([])
}, 30_000)

test('a task with tools streams too, and says when a tool is the thing being waited for', async () => {
  script = [{ call: 'streamed__look' }, { say: ['It ', 'was ', 'there.'] }]
  const seen = await press('task')
  expect(seen.text).toBe('It was there.')
  const stages = seen.streamed.map((frame) => frame.phase).filter(Boolean)
  expect(stages).toContain('tool')
  expect(stages.indexOf('tool')).toBeLessThan(stages.lastIndexOf('writing'))
  expect(joined(seen.streamed)).toBe(seen.text)
}, 30_000)

test('a slash command streams nothing, and hands over its data on the result', async () => {
  const help = await press('help')
  expect(help.frames).toEqual([])
  const list = help.meta?.['alexia/command'] as { name: string; summary: string }[]
  expect(list.map((one) => one.name)).toEqual(expect.arrayContaining(['new', 'help', 'status']))
  expect(help.text).toContain('/status —')

  const status = await press('status')
  expect(status.frames).toEqual([])
  expect(status.meta?.['alexia/command']).toMatchObject({ mode: 'combined', prefer: 'cheap', running: false })
  expect(status.text).toMatch(/^Combined · cheapest first · .* · nothing running$/)
}, 30_000)

// Last, because a model that has just failed is not asked first again (D159), and every test
// above wants the plan the way it starts.
test('a model that dies mid-sentence sends a restart, and the words after it are the answer', async () => {
  script = [{ dies: 'Half of' }, { say: ['from ', 'the ', 'next ', 'one'] }]
  const seen = await press('plain')
  expect(seen.text).toBe('from the next one')

  const kinds = seen.streamed.flatMap((frame) => [
    ...(frame.delta !== undefined ? [`delta:${frame.delta}`] : []),
    ...(frame.restart === true ? ['restart'] : []),
  ])
  // The half sentence went out, the restart told the plugin to drop it, and what follows is whole.
  expect(kinds[0]).toBe('delta:Half of')
  expect(kinds).toContain('restart')
  expect(kinds.indexOf('restart')).toBeGreaterThan(0)
  expect(joined(seen.streamed)).toBe(seen.text)
}, 30_000)
