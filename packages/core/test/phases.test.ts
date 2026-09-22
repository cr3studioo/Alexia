// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { noPolling } from './staged.js'
import { run, type Tooling } from '../src/agent.js'
import type { Model } from '../src/catalog.js'
import { remaining } from '../src/pool.js'
import { keyOf, type Provider } from '../src/provider.js'
import { MODES, type Phase } from '../src/router.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'
import { Store } from '../src/store.js'

/**
 * **The stages that happen outside `send()`**, and the one road every stage takes to the screen.
 *
 * The line under the question replaces a silent `…`, and Alexia.md is plain about why: silence
 * is what kills a first run, not time. `send()` says *asking* and *writing* for itself; what it
 * cannot say is the work around it — the loop choosing a model before it asks one, a tool
 * running between two answers, attachments being read before anything is asked at all. Those
 * are said here, and this file holds them still: in the loop, and over the real wire.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-phases-'))

/**
 * One scripted model: the first request of a script calls a tool, the next answers. Every
 * request is written into {@link log} as it arrives, so a stage can be placed before or after
 * the model call it belongs to by nothing cleverer than its position in one list.
 */
let script: ({ say: string } | { call: string })[] = []
const log: string[] = []
const models: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    log.push('model')
    const turn = script.shift() ?? { say: 'said something' }
    const delta =
      'call' in turn ?
        { tool_calls: [{ index: 0, id: `c${String(log.length)}`, function: { name: turn.call, arguments: '{}' } }] }
      : { content: turn.say }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n` +
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

const row: Model = {
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
}
noPolling(root, [row])

const secrets = memorySecrets()
await secrets.set(CORE, keyOf(stub), 'sk-stub')
// `local: false`, because this Mac may answer on 127.0.0.1:11434 and a test that found Ollama
// would be testing Ollama.
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

/** One POST to `/api/chat`: the stream as it came, and every frame in it. */
async function chat(body: Record<string, unknown>): Promise<{ raw: string; events: Record<string, unknown>[] }> {
  const response = await fetch(new URL('/api/chat', alexia.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
    body: JSON.stringify(body),
  })
  const raw = await response.text()
  const events = raw
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>)
  return { raw, events }
}

const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
  (await (
    await fetch(new URL(path, alexia.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
      body: JSON.stringify(body),
    })
  ).json()) as Record<string, unknown>

/** The newest run on the activity panel, as its export reads. */
async function newestRun(): Promise<string> {
  const listed = (await post('/api/rows', { key: 'activity' })) as { rows?: { id: string }[] }
  const opened = (await post('/api/detail', { key: 'activity', row: listed.rows?.[0]?.id })) as { text?: string }
  return opened.text ?? ''
}

const kindOf = (event: Record<string, unknown>): string | undefined => (event.phase as Phase | undefined)?.kind

test('the loop says it is choosing before each step asks a model, and names the tool it runs', async () => {
  script = [{ call: 'notes.read' }, { say: 'It says hi.' }]
  log.length = 0
  const store = new Store(':memory:')
  const session = store.createSession()
  const tools: Tooling = {
    list: () => Promise.resolve([{ name: 'notes.read', description: 'Read a note.' }]),
    call: () => Promise.resolve({ text: 'the note says hi', ok: true }),
  }

  const result = await run({
    messages: [{ role: 'user', content: 'read my note' }],
    tools,
    pins: { placement: MODES.combined },
    world: () => Promise.resolve({ models: [row], local: [], rungs: [remaining(store, stub)] }),
    store,
    secrets,
    session,
    on: {
      phase: (phase) => {
        // Only the two stages the loop owns. `send()` says its own — asking, writing — and
        // they would sit between these without changing the order this is about.
        if (phase.kind === 'choosing') log.push('choosing')
        if (phase.kind === 'tool') log.push(`tool ${phase.name}`)
      },
    },
  })

  expect(result.ended).toBe('answered')
  // A step is choosing, then the model; a tool runs between two steps; and the second step
  // chooses again, because every step re-asks the router.
  expect(log).toEqual(['choosing', 'model', 'tool notes.read', 'choosing', 'model'])
  store.close()
})

test('over the wire, a message says it is choosing before the first word arrives', async () => {
  script = []
  const { raw, events } = await chat({ text: 'hello there' })

  // The screen's own stream, the frame exactly as the shell reads it.
  expect(raw).toContain('data: {"phase":{"kind":"choosing"}}')
  const choosing = events.findIndex((event) => kindOf(event) === 'choosing')
  const first = events.findIndex((event) => 'delta' in event)
  expect(choosing).toBeGreaterThanOrEqual(0)
  expect(first).toBeGreaterThan(choosing)
  // Nothing before it but the stages themselves: the `…` has something to say from the start.
  expect(events.slice(0, choosing).every((event) => 'phase' in event)).toBe(true)

  // And the trace kept it, timed.
  const text = await newestRun()
  expect(text).toContain('## Where the time went')
  expect(text).toMatch(/ {2}\d+\.\ds {2}choosing\n/)
}, 30_000)

test('a message with a file says it is reading before anything else', async () => {
  script = []
  const { events } = await chat({
    text: 'what does this say',
    files: [{ name: 'note.txt', data: Buffer.from('hello from a file').toString('base64') }],
  })

  // First of all — before the line saying what became of the file, and before choosing.
  expect(events[0]).toEqual({ phase: { kind: 'reading' } })
  const kinds = events.flatMap((event) => {
    const kind = kindOf(event)
    return kind === undefined ? [] : [kind]
  })
  expect(kinds.slice(0, 2)).toEqual(['reading', 'choosing'])

  // Read before the run opened, and still on its record with its own length, first.
  const text = await newestRun()
  const stages = text.split('## Where the time went\n')[1]?.split('\n') ?? []
  expect(stages[0]).toMatch(/^ {2}\d+\.\ds {2}reading$/)
  expect(stages[1]).toMatch(/^ {2}\d+\.\ds {2}choosing$/)
}, 30_000)
