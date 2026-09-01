// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { fetchModel, forget, have } from '../models.js'
import { paths } from '../launch.js'

/**
 * Seven gigabytes is an errand rather than a request, so what is tested here is what happens
 * when it is interrupted — the two ways a long download goes wrong being *starts again from
 * zero* and *ends up looking finished when it is not*.
 */
const BODY = Buffer.from('x'.repeat(2000))
let at
let server
/** What range the last request asked for, so a test can prove it resumed rather than restarted. */
let asked
/** When set, the server ignores Range and answers with the whole body. */
let stubborn = false

beforeAll(async () => {
  server = createServer((request, response) => {
    asked = request.headers.range
    if (request.url === '/truncated') {
      // What an interrupted download actually looks like: some bytes, then the connection goes.
      // A server that simply ends short of its own `content-length` leaves the client waiting
      // rather than failing, which is a different and much rarer thing.
      response.writeHead(200, { 'content-length': String(BODY.length) })
      response.write(BODY.subarray(0, 500))
      return setTimeout(() => response.socket?.destroy(), 10)
    }
    const range = stubborn ? undefined : request.headers.range
    if (range) {
      const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0)
      const rest = BODY.subarray(from)
      response.writeHead(206, { 'content-length': String(rest.length), 'content-range': `bytes ${from}-${BODY.length - 1}/${BODY.length}` })
      return response.end(rest)
    }
    response.writeHead(200, { 'content-length': String(BODY.length) })
    response.end(BODY)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  at = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((r) => server.close(r)))

const scratch = () => mkdtempSync(join(tmpdir(), 'alexia-models-'))

test('a whole file arrives, and the path only ever holds a whole file', async () => {
  const to = join(scratch(), 'model.safetensors')
  const got = await fetchModel(`${at}/model`, to, { expect: BODY.length })
  expect(got.bytes).toBe(BODY.length)
  expect(got.already).toBe(false)
  expect(readFileSync(to).length).toBe(BODY.length)
  // The `.part` is the commit boundary: it must be gone once the real file exists.
  expect(existsSync(`${to}.part`)).toBe(false)
})

test('a model already on disk is not fetched again', async () => {
  const to = join(scratch(), 'model.safetensors')
  writeFileSync(to, BODY)
  const got = await fetchModel(`${at}/model`, to, { expect: BODY.length })
  expect(got.already).toBe(true)
  // Seven gigabytes of nothing, avoided. The commonest case on any run after the first.
  expect(got.bytes).toBe(BODY.length)
})

test('an interrupted download carries on rather than starting again', async () => {
  const to = join(scratch(), 'model.safetensors')
  writeFileSync(`${to}.part`, BODY.subarray(0, 800))
  expect((await have(to)).part).toBe(800)
  const got = await fetchModel(`${at}/model`, to, { expect: BODY.length })
  expect(asked).toBe('bytes=800-')
  expect(got.bytes).toBe(BODY.length)
  expect(readFileSync(to).length).toBe(BODY.length)
})

test('a server that ignores Range starts again instead of writing a file that is too long', async () => {
  // Appending a whole body to a partial one produces a file of the wrong length that looks
  // finished — a corrupt checkpoint that fails later, inside ComfyUI, for no visible reason.
  const to = join(scratch(), 'model.safetensors')
  writeFileSync(`${to}.part`, BODY.subarray(0, 800))
  stubborn = true
  try {
    const got = await fetchModel(`${at}/model`, to, { expect: BODY.length })
    expect(got.bytes).toBe(BODY.length)
    expect(readFileSync(to).length).toBe(BODY.length)
  } finally {
    stubborn = false
  }
})

test('a dropped connection leaves nothing at the real path, and keeps what arrived', async () => {
  const to = join(scratch(), 'model.safetensors')
  await expect(fetchModel(`${at}/truncated`, to, { expect: BODY.length })).rejects.toThrow()
  // **The rename is the commit.** Whatever else happens, a file at the real path is a whole
  // file — a partial one there is a corrupt checkpoint that fails later, inside ComfyUI, for no
  // reason anybody can connect back to a download that was interrupted days earlier.
  expect(existsSync(to)).toBe(false)
  // And what did arrive is kept, so asking again carries on instead of starting over.
  expect((await have(to)).part).toBeGreaterThan(0)
  await forget(to)
  expect((await have(to)).part).toBe(0)
})

test('progress is reported in something a person reads, not once per chunk', async () => {
  const to = join(scratch(), 'model.safetensors')
  const said = []
  await fetchModel(`${at}/model`, to, { expect: BODY.length, onProgress: (done, total, text) => said.push({ done, total, text }) })
  // Throttled to about once a second, so a small file may report nothing at all — which is the
  // point. What must never happen is half a million messages for a real one.
  expect(said.length).toBeLessThan(5)
  for (const one of said) expect(one.text).toMatch(/Downloading the model/)
})

test('ComfyUI is pointed at Alexia’s own model folder without anything being written into its install', () => {
  // The whole reason the model lives on Alexia's side: a six-gigabyte file in somebody's own
  // ComfyUI folder is residue a plugin cannot honestly remove, and invariant 3 says it must.
  const own = scratch()
  const yaml = readFileSync(paths(own), 'utf8')
  expect(yaml).toMatch(/^alexia:/m)
  expect(yaml).toMatch(/checkpoints: models\/checkpoints\//)
  expect(yaml).toMatch(/loras: models\/loras\//)
  // Forward slashes throughout, because a backslash in a YAML scalar is a question nobody needs
  // to ask — and on Windows every path this is built from arrives full of them.
  expect(yaml.includes(String.fromCharCode(92))).toBe(false)
  // `is_default` stays out: these paths are searched, not preferred, so ComfyUI's own downloads
  // keep going where that person already expects them.
  expect(yaml).not.toMatch(/is_default/)
  // And the folders exist, because ComfyUI logs a warning for a search path that does not.
  expect(existsSync(join(own, 'models', 'checkpoints'))).toBe(true)
})
