// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'

// The bridge between a webview and core: the shell it serves, the token that guards it, and
// one turn end to end. No provider is connected here, so the answer is the router's
// refusal — which is the path worth having a test for anyway, because it is the one a
// person meets on their first evening.

const root = mkdtempSync(join(tmpdir(), 'alexia-serve-'))
// A catalog fetched a moment ago, so starting the server does not reach for the network.
mkdirSync(join(root, 'cache'), { recursive: true })
writeFileSync(join(root, 'cache', 'models.json'), JSON.stringify({ fetchedAt: Date.now(), models: [] }))

const ui = join(import.meta.dirname, '..', '..', 'ui')
const alexia: Serving = await serve({ dataDir: root, uiDir: ui, secrets: memorySecrets() })
afterAll(() => alexia.close())

const get = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(new URL(path, alexia.url), {
    ...init,
    headers: { 'x-alexia-token': alexia.token, ...init.headers },
  })

/** The `data:` frames of one answer, collected. */
async function stream(text: string): Promise<Record<string, unknown>[]> {
  const response = await get('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  return (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>)
}

test('the shell is served with the token baked into it', async () => {
  const page = await (await fetch(alexia.url)).text()
  expect(page).toContain('<title>Alexia</title>')
  expect(page).toContain(alexia.token)
  expect(page).not.toContain('__TOKEN__')

  // The compiled shell, and no bundler in sight.
  expect((await fetch(new URL('/main.js', alexia.url))).status).toBe(200)

  // Step 2 of Alexia.md's first run, in its own words. It is the first sentence anybody
  // reads, it had drifted to "What should I call me?", and nothing was watching it.
  expect(page).toContain('What should I call you?')
})

test('the one image core serves arrives as the bytes it was written as', async () => {
  // The token substitution above is a string operation, and a PNG decoded as UTF-8 to run
  // one comes back subtly broken — a blank tab icon and nothing in the log to say why.
  const image = await fetch(new URL('/alexia.png', alexia.url))
  expect(image.headers.get('content-type')).toBe('image/png')

  const bytes = new Uint8Array(await image.arrayBuffer())
  expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expect(bytes.byteLength).toBe(statSync(join(ui, 'alexia.png')).size)
})

test('a local server that spends money is not open to whatever else is on the machine', async () => {
  const naked = await fetch(new URL('/api/state', alexia.url))
  expect(naked.status).toBe(403)

  const wrong = await fetch(new URL('/api/state', alexia.url), { headers: { 'x-alexia-token': 'guess' } })
  expect(wrong.status).toBe(403)

  expect((await get('/api/state')).status).toBe(200)
})

/** A request target sent verbatim. `fetch` resolves its argument as a URL, which is exactly
 * the thing being tested, so it cannot ask this question. */
function raw(target: string): Promise<number> {
  const port = Number(new URL(alexia.url).port)
  return new Promise((resolve, reject) => {
    const call = httpRequest({ host: '127.0.0.1', port, path: target }, (answer) => {
      answer.resume()
      resolve(answer.statusCode ?? 0)
    })
    call.on('error', reject)
    call.end()
  })
}

test('a request target that is not a path is refused, not answered and not a 500', async () => {
  // Reading the target *against* an origin made a leading `//` protocol-relative: `//app.css`
  // meant the host `app.css` at path `/`, so the shell came back for any path at all, and a
  // bare `//` had no host to parse and became a 500. Neither is an answer; both are refusals.
  expect(await raw('//app.css')).toBe(403)
  expect(await raw('//')).toBe(403)

  // And the path that is a path still is one.
  expect(await raw('/app.css')).toBe(200)
})

test('a turn is kept even when the answer is a refusal', async () => {
  const events = await stream('sort my downloads')

  // Nothing is connected and there is no local model, so the router says so — and says it
  // in words with an action in them, which is what reaches the screen unaltered.
  expect(events.at(-1)?.error).toContain('add a key in settings')

  // The question is in the history regardless. Losing what somebody typed because nothing
  // could answer it would be its own small betrayal.
  const state = (await (await get('/api/state')).json()) as { messages: { content: string }[]; spent: number }
  expect(state.messages.map((m) => m.content)).toEqual(['sort my downloads'])
  expect(state.spent).toBe(0)
})

test('first run asks three things and then never asks again', async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'alexia-first-'))
  mkdirSync(join(fresh, 'cache'), { recursive: true })
  writeFileSync(join(fresh, 'cache', 'models.json'), JSON.stringify({ fetchedAt: Date.now(), models: [] }))
  const secrets = memorySecrets()
  const first = await serve({ dataDir: fresh, uiDir: ui, secrets })
  const call = (path: string, init: RequestInit = {}) =>
    fetch(new URL(path, first.url), { ...init, headers: { 'x-alexia-token': first.token, ...init.headers } })

  const read = async () =>
    (await (await call('/api/state')).json()) as {
      setup: { done: boolean; name: string }
      providers: { id: string; trainsOnYourData: string; terms?: string; connected: boolean }[]
    }

  const before = await read()
  expect(before.setup).toEqual({ done: false, name: 'Alexia', mode: 'combined' })
  // What the mode picker is honest about: nobody has read these terms yet.
  expect(before.providers.every((p) => p.trainsOnYourData === 'unknown' && p.terms)).toBe(true)
  expect(before.providers.some((p) => p.connected)).toBe(false)

  await call('/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ada', mode: 'local', provider: { id: 'openrouter', key: 'sk-users-own' } }),
  })

  const after = await read()
  expect(after.setup).toEqual({ done: true, name: 'Ada', mode: 'local' })
  // The key went to the keychain and nowhere near the database.
  expect(await secrets.get('_core', 'provider/openrouter')).toBe('sk-users-own')
  // And the screen can say so without being able to read it back — which is what stops the
  // settings box looking identical whether or not somebody has already pasted a key.
  expect(after.providers.filter((p) => p.connected).map((p) => p.id)).toEqual(['openrouter'])

  // The settings screen writes the same route with one field at a time: a rename does not
  // un-choose the mode, and a second key replaces the first rather than adding to it.
  await call('/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Grace' }),
  })
  await call('/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: { id: 'openrouter', key: 'sk-the-second-one' } }),
  })

  const edited = await read()
  expect(edited.setup).toEqual({ done: true, name: 'Grace', mode: 'local' })
  expect(await secrets.get('_core', 'provider/openrouter')).toBe('sk-the-second-one')

  await first.close()
})

test('a reopened Alexia is the same conversation', async () => {
  const again = await serve({ dataDir: root, uiDir: ui, secrets: memorySecrets() })
  const state = (await (
    await fetch(new URL('/api/state', again.url), { headers: { 'x-alexia-token': again.token } })
  ).json()) as { messages: { content: string }[] }

  expect(state.messages.map((m) => m.content)).toEqual(['sort my downloads'])
  // A new token every start, so yesterday's page cannot talk to today's Alexia.
  expect(again.token).not.toBe(alexia.token)
  await again.close()
})
