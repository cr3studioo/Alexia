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
 * **A tool makes a file, and the person who asked ends up holding it.**
 *
 * The whole path, over the real wire: a plugin returns MCP's own `resource_link`, core names
 * the file for the model and gives the shell an id for it, and the bytes come back down a
 * route that has never been told a path. What the unit tests beside this cannot reach is the
 * middle — that the id reaches the screen on the step event and resolves afterwards — so
 * that is what this is for.
 *
 * The gap it closes was real before it was designed. `plugins/media` finished generating a
 * picture and returned its path *in prose*; there was nothing to press, and the file sat on
 * the user's own disk behind a sentence.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-making-'))
const from = mkdtempSync(join(tmpdir(), 'alexia-maker-'))

/** A scripted model: call this tool, then say this. */
let script: ({ call: string; args?: Record<string, unknown> } | { say: string })[] = []
const models: Server = createServer((request, response) => {
  request.on('data', () => {})
  request.on('end', () => {
    const turn = script.shift() ?? { say: 'done' }
    const delta =
      'call' in turn ?
        {
          tool_calls: [
            { index: 0, id: 'c1', function: { name: turn.call, arguments: JSON.stringify(turn.args ?? {}) } },
          ],
        }
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

mkdirSync(join(from, 'maker'), { recursive: true })
writeFileSync(
  join(from, 'maker', 'plugin.json'),
  JSON.stringify({
    manifest_version: 1,
    id: 'maker',
    name: 'Maker',
    summary: 'Writes a file and hands it back, which is what a document or picture plugin does.',
    version: '0.1.0',
    license: 'AGPL-3.0-only',
    entry: { run: 'node', args: [join(import.meta.dirname, 'fixtures', 'maker.js')] },
    alexia_protocol: 3,
    mcp_protocol: '2025-11-25',
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
})

afterAll(async () => {
  await alexia.close()
  models.close()
  for (const path of [root, from]) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/**
 * Full trust, said out loud, because the fixture is honest about what it does.
 *
 * A tool that writes a file declares `readOnlyHint: false`, and the default mode stops on
 * exactly that — correctly. The alternative was a fixture claiming to be read-only, which
 * would make every turn here pass by lying about the one thing the gate reads. What is
 * under test is what happens to a file after a tool made it; the gate in front of that has
 * its own suite and is not this one's subject.
 */
await fetch(new URL('/api/permissions', alexia.url), {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
  body: JSON.stringify({ mode: 'full-trust' }),
})

const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
  (await (
    await fetch(new URL(path, alexia.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
      body: JSON.stringify(body),
    })
  ).json()) as Record<string, unknown>

interface Offered {
  id: string
  name: string
  bytes: number
  mime: string
  path: string
  openable: boolean
}

/** One turn, and everything the shell was told during it. */
async function turn(text: string): Promise<{ events: Record<string, unknown>[]; text: string }> {
  const response = await fetch(new URL('/api/chat', alexia.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
    body: JSON.stringify({ text }),
  })
  const raw = await response.text()
  const events = raw
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>)
  return { events, text: raw }
}

const filesIn = (events: Record<string, unknown>[]): Offered[] =>
  events.flatMap((event) => ((event.step as { files?: Offered[] } | undefined)?.files ?? []))

test('a file a tool made arrives on the step, with an id and never as something to ask for by path', async () => {
  expect((await post('/api/plugin', { id: 'maker', action: 'enable' })).ok).toBe(true)
  script = [{ call: 'maker__make', args: { name: 'report.txt' } }, { say: 'There you go.' }]

  const { events } = await turn('make me a report')
  const [file] = filesIn(events)

  expect(file).toBeDefined()
  expect(file!.name).toBe('report.txt')
  expect(file!.bytes).toBeGreaterThan(0)
  // The path is shown — *copy path* is one of the four things a person wants — but it is
  // never what any route accepts back. The id is.
  expect(file!.path).toContain('report.txt')
  expect(file!.id).toMatch(/^[0-9a-f]{32}$/)
  expect(file!.openable).toBe(true)

  // And what the model was told, which is all it can use: a name, in the step's own text.
  const outcome = events.find((event) => (event.step as { text?: string } | undefined)?.text !== undefined)
  expect((outcome!.step as { text: string }).text).toContain('[file: report.txt]')
}, 30_000)

test('the bytes come back by that id, named, and not as something to render in place', async () => {
  script = [{ call: 'maker__make', args: { name: 'notes.md' } }, { say: 'Done.' }]
  const [file] = filesIn((await turn('write notes')).events)

  const answered = await fetch(new URL(`/api/file?id=${encodeURIComponent(file!.id)}`, alexia.url), {
    headers: { 'x-alexia-token': alexia.token },
  })
  expect(answered.status).toBe(200)
  expect(await answered.text()).toBe('the contents of notes.md')
  expect(answered.headers.get('content-type')).toContain('text/markdown')
  // So a browser reaching the route directly saves it under the name it was given rather
  // than under a hex id.
  expect(answered.headers.get('content-disposition')).toContain('notes.md')
}, 30_000)

test('a file the tool named and never wrote is not offered, and the model is told', async () => {
  script = [{ call: 'maker__make', args: { name: 'ghost.txt', skip: true } }, { say: 'Hmm.' }]
  const { events } = await turn('make a ghost')

  expect(filesIn(events)).toEqual([])
  const outcome = events.find((event) => (event.step as { text?: string } | undefined)?.text !== undefined)
  expect((outcome!.step as { text: string }).text).toContain('not written')
}, 30_000)

test('a tool that made nothing is exactly what it was before any of this', async () => {
  // The regression that would matter most, because it is every other tool in the repo: no
  // `files` on the step at all, rather than an empty list the shell has to know to ignore.
  script = [{ call: 'maker__say_only' }, { say: 'Nothing to give you.' }]
  const { events } = await turn('just talk')

  expect(filesIn(events)).toEqual([])
  expect(events.some((event) => 'files' in ((event.step as object | undefined) ?? {}))).toBe(false)
}, 30_000)

test('an id from a finished turn still resolves, because a conversation is read afterwards', async () => {
  // A person scrolls up and presses Save on something from three answers ago. The registry
  // is for as long as core is up, and this is the behaviour that makes that the right scope.
  script = [{ call: 'maker__make', args: { name: 'early.txt' } }, { say: 'Done.' }]
  const [early] = filesIn((await turn('make an early one')).events)

  script = [{ say: 'Nothing to do.' }]
  await turn('and now something else')
  script = [{ say: 'Still nothing.' }]
  await turn('and again')

  const answered = await fetch(new URL(`/api/file?id=${encodeURIComponent(early!.id)}`, alexia.url), {
    headers: { 'x-alexia-token': alexia.token },
  })
  expect(answered.status).toBe(200)
  expect(await answered.text()).toBe('the contents of early.txt')
}, 30_000)

test('a file that has gone since it was offered says so rather than failing silently', async () => {
  script = [{ call: 'maker__make', args: { name: 'fleeting.txt' } }, { say: 'Done.' }]
  const [file] = filesIn((await turn('make a fleeting one')).events)
  rmSync(file!.path, { force: true })

  const answered = await fetch(new URL(`/api/file?id=${encodeURIComponent(file!.id)}`, alexia.url), {
    headers: { 'x-alexia-token': alexia.token },
  })
  // Gone, not missing: the id was real and the file is not there any more. A person who
  // moved it themselves is told what happened rather than shown a broken button.
  expect(answered.status).toBe(410)
  expect(((await answered.json()) as { said: string }).said).toContain('no longer where it was made')
}, 30_000)
