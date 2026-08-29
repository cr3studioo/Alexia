// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { clone, FORMATS, HOST, idOf, mine, MODEL, PREFIX, remove, say } from '../fish.js'

/**
 * The second engine (M7-4), against a stub that answers the way the vendor does.
 *
 * **What this proves and what it does not.** It proves the request shapes, the error path
 * and the id handling. It does not prove the live API agrees — there is no key on this
 * machine, and a test that pretended otherwise would be worse than none. The synthesis and
 * listing shapes were run live by the predecessor on 2026-08-13; the clone call is written
 * from the published shape and is confirmed on the first real key.
 */

const seen = []
const server = createServer((request, response) => {
  let raw = Buffer.alloc(0)
  request.on('data', (chunk) => (raw = Buffer.concat([raw, chunk])))
  request.on('end', () => {
    seen.push({
      url: request.url,
      method: request.method,
      auth: request.headers.authorization,
      model: request.headers.model,
      body: raw,
    })
    if (raw.includes('broke')) {
      // What the vendor's paid default actually answers on an account with no API credit,
      // which is the failure a person will meet first and the one worth naming.
      response.writeHead(402, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: 'Insufficient API credit' }))
      return
    }
    if (request.url === '/v1/tts') {
      response.writeHead(200, { 'content-type': 'audio/wav' })
      response.end(Buffer.from([1, 2, 3, 4]))
      return
    }
    if (request.method === 'DELETE') {
      response.writeHead(204)
      response.end()
      return
    }
    if (request.method === 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ _id: 'made-1', title: 'my voice' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        items: [
          { _id: 'a', title: 'Mine', state: 'trained' },
          // Listed by the API and unable to speak. Offering it would offer a voice that
          // fails at the moment somebody uses it.
          { _id: 'b', title: 'Still training', state: 'training' },
        ],
      }),
    )
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const root = mkdtempSync(join(tmpdir(), 'alexia-fish-'))
afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

/** The stub stands in for the API root, which is the only seam this module has. */
HOST.at = `http://127.0.0.1:${server.address().port}`

test('a cloned voice id round-trips, and nothing else is mistaken for one', () => {
  expect(idOf(`${PREFIX}abc123`)).toBe('abc123')
  // A Piper stem is not a cloned voice, and a bare prefix names nothing.
  expect(idOf('lessac')).toBeUndefined()
  expect(idOf('en_US-amy-medium')).toBeUndefined()
  expect(idOf(PREFIX)).toBeUndefined()
})

test('the model family is pinned, and Telegram’s format is on the list', () => {
  // The vendor's own default is paid and answers 402 on an account with no API credit, and
  // the marker syntax differs by family — S2 takes brackets, the legacy S1 takes parens.
  expect(MODEL).toBe('s2.1-pro-free')
  expect(FORMATS).toContain('opus')
})

test('a clip and its words go up as one form, and the voice comes back named', async () => {
  const wav = join(root, 'me.wav')
  writeFileSync(wav, Buffer.from([0x52, 0x49, 0x46, 0x46]))
  seen.length = 0

  const made = await clone('sk-secret', { name: 'my voice', wav, transcript: 'The words that were said.' })
  expect(made).toEqual({ id: 'made-1', name: 'my voice' })

  const [request] = seen
  expect(request.method).toBe('POST')
  expect(request.auth).toBe('Bearer sk-secret')
  const body = request.body.toString('latin1')
  expect(body).toContain('The words that were said.')
  // Private, always. Publishing somebody's own voice on their behalf is the worst kind of
  // default, and a form field is the whole of what stops it.
  expect(body).toContain('private')
})

test('only a trained voice is offered, and one is removed by name', async () => {
  expect(await mine('sk-secret')).toEqual([{ id: 'a', name: 'Mine' }])
  seen.length = 0
  await remove('sk-secret', 'a')
  expect(seen[0]).toMatchObject({ method: 'DELETE', url: '/model/a' })
})

test('markers are passed through untouched, and the family rides in the header', async () => {
  seen.length = 0
  const audio = await say('sk-secret', { text: '[happy]Here it is.', id: 'a', format: 'opus' })
  expect([...audio]).toEqual([1, 2, 3, 4])

  const [request] = seen
  expect(request.model).toBe(MODEL)
  const sent = JSON.parse(request.body.toString())
  // Never invented and never stripped here: filtering is `expression.js`'s job, and doing it
  // in two places would make it impossible to debug in either.
  expect(sent).toEqual({ text: '[happy]Here it is.', reference_id: 'a', format: 'opus' })
})

test('the vendor’s own words come back, and the key never does', async () => {
  // A person debugging a dead voice note needs the cause, and the cause is usually the
  // sentence the API sent back rather than a status number.
  const said = await say('sk-secret', { text: 'x', id: 'broke' }).catch((error) => error.message)
  expect(said).toContain('402')
  expect(said).toContain('Insufficient API credit')

  // And a key that reaches a message is a key in somebody's bug report.
  const leaked = await say('sk-secret-broke', { text: 'x', id: 'broke' }).catch((error) => error.message)
  expect(leaked).not.toContain('sk-secret-broke')
})

test('an unreachable API is a sentence rather than a stack trace', async () => {
  const was = HOST.at
  HOST.at = 'http://127.0.0.1:1'
  const said = await mine('sk-secret').catch((error) => error.message)
  expect(said).toContain('unreachable')
  HOST.at = was
})
