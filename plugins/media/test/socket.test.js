// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { CLIENT_ID, preview, queue, wait } from '../comfy.js'

/**
 * The step counter, against a server that speaks the protocol ComfyUI speaks.
 *
 * **This suite exists for one bug, and the bug is silent.** ComfyUI sends every progress message
 * to `server_instance.client_id` and to nobody else, and its socket table is keyed by the
 * `clientId` query parameter. So if the socket connects with one id and the prompt is queued with
 * another, the socket opens, the handshake succeeds, and **nothing ever arrives** — which looks
 * exactly like a slow graphics card. A test that asserted a socket opened would pass while the
 * feature was entirely broken, so these assert that a message was *received* and that the two
 * ids were *the same*.
 *
 * Twenty-five lines of RFC 6455 rather than a dependency: the handshake is one SHA-1, and a text
 * frame under 126 bytes is an opcode, a length and the bytes.
 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const accept = (key) =>
  createHash('sha1')
    .update(key + GUID)
    .digest('base64')

/** One text frame. Short payloads only, which is all any of these are. */
function frame(text) {
  const body = Buffer.from(text, 'utf8')
  if (body.length > 125) throw new Error('this fake only sends short frames')
  return Buffer.concat([Buffer.from([0x81, body.length]), body])
}

let comfy
let at
/** What the socket said it was, so the test can compare it with what the prompt said. */
let socketId
/** What the prompt body said it was. */
let promptId
let sock
let polls = 0

beforeAll(async () => {
  comfy = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const send = (body) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.method === 'POST' && url.pathname === '/prompt') {
      const chunks = []
      request.on('data', (c) => chunks.push(c))
      return request.on('end', () => {
        promptId = JSON.parse(Buffer.concat(chunks).toString('utf8')).client_id
        send({ prompt_id: 'job-1' })
      })
    }
    if (url.pathname === '/queue') return send({ queue_running: [[0, 'job-1']], queue_pending: [] })
    if (url.pathname === '/history/job-1') {
      polls += 1
      // Not finished for the first two polls, so the socket has a turn before the answer lands.
      if (polls < 3) return send({})
      return send({ 'job-1': { outputs: { 9: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } })
    }
    response.writeHead(404)
    response.end()
  })

  comfy.on('upgrade', (request, socket) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    socketId = url.searchParams.get('clientId')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept(request.headers['sec-websocket-key'])}\r\n\r\n`,
    )
    sock = socket
    // What ComfyUI sends while a sampler runs, in its own shape.
    socket.write(frame(JSON.stringify({ type: 'executing', data: { node: '3', prompt_id: 'job-1' } })))
    socket.write(frame(JSON.stringify({ type: 'progress', data: { value: 12, max: 28, node: '3', prompt_id: 'job-1' } })))
    // A job somebody else queued from a browser tab. It must not be mistaken for this one.
    socket.write(frame(JSON.stringify({ type: 'progress', data: { value: 3, max: 999, node: '9', prompt_id: 'somebody-else' } })))
  })

  await new Promise((resolve) => comfy.listen(0, '127.0.0.1', resolve))
  at = `http://127.0.0.1:${comfy.address().port}`
})

afterAll(
  () =>
    new Promise((resolve) => {
      sock?.destroy()
      comfy.close(resolve)
    }),
)

test('the socket and the prompt carry the same id, and the steps actually arrive', async () => {
  const said = []
  const id = await queue(at, { 3: { class_type: 'KSampler', inputs: {} } })
  const made = await wait(at, id, {
    label: (node) => (node === '3' ? 'KSampler' : undefined),
    onProgress: (message, done, total) => said.push({ message, done, total }),
  })

  // The bug, asserted directly: one id, used twice.
  expect(socketId).toBe(CLIENT_ID)
  expect(promptId).toBe(CLIENT_ID)
  expect(socketId).toBe(promptId)

  // And a message actually arrived — which is the half a connection test would have missed.
  const stepped = said.find((one) => one.total === 28)
  expect(stepped, `no step message arrived; got ${JSON.stringify(said)}`).toBeDefined()
  expect(stepped.done).toBe(12)
  // Named in the words of the graph rather than by node id.
  expect(stepped.message).toBe('KSampler — step 12 of 28')

  // Somebody else's render in the same ComfyUI must not become this job's progress bar.
  expect(said.some((one) => one.total === 999)).toBe(false)

  expect(made.files.map((one) => one.filename)).toEqual(['out.png'])
})

test('a socket that never connects leaves the old polling behaviour exactly as it was', async () => {
  // The reconnect story the original comment was avoiding: there isn't one. Nothing depends on
  // the socket staying up, so a server with no `/ws` at all still finishes a render.
  const quiet = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    response.writeHead(200, { 'content-type': 'application/json' })
    if (url.pathname === '/queue') return response.end(JSON.stringify({ queue_running: [], queue_pending: [] }))
    return response.end(JSON.stringify({ 'job-2': { outputs: { 9: { images: [{ filename: 'still.png' }] } } } }))
  })
  await new Promise((resolve) => quiet.listen(0, '127.0.0.1', resolve))
  const to = `http://127.0.0.1:${quiet.address().port}`
  const said = []
  const made = await wait(to, 'job-2', { onProgress: (message) => said.push(message) })
  expect(made.files.map((one) => one.filename)).toEqual(['still.png'])
  await new Promise((resolve) => quiet.close(resolve))
})

test('a preview frame is read out of the bytes ComfyUI sends it as', () => {
  // Both layouts, packed exactly as `server.py` packs them: big-endian, event first. Read off
  // the source rather than documentation, because this is the kind of thing docs lag on.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  const plain = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0, 0, 0, 1]), jpeg])
  expect(preview(new Uint8Array(plain))).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`)

  // Type 2 is PNG, in the same slot.
  const png = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0, 0, 0, 2]), jpeg])
  expect(preview(new Uint8Array(png))).toMatch(/^data:image\/png;base64,/)

  // The metadata layout: a length, the JSON, then the image. Sent only to a client that asked
  // for it by feature flag, and handled anyway because asking is one line away.
  const meta = Buffer.from(JSON.stringify({ image_type: 'image/webp' }), 'utf8')
  const withMeta = Buffer.concat([
    Buffer.from([0, 0, 0, 4]),
    Buffer.from([0, 0, 0, meta.length]),
    meta,
    jpeg,
  ])
  expect(preview(new Uint8Array(withMeta))).toBe(`data:image/webp;base64,${jpeg.toString('base64')}`)
})

test('anything that is not a preview frame is ignored rather than guessed at', () => {
  // This is the one plugin-supplied string that becomes something the shell loads into an
  // `img`, so everything uncertain about it stops here.
  expect(preview(new Uint8Array([0, 0, 0, 1]))).toBeUndefined()
  expect(preview(new Uint8Array([0, 0, 0, 9, 0, 0, 0, 1, 1, 2]))).toBeUndefined()
  // A metadata length that runs past the end of the buffer.
  expect(preview(new Uint8Array([0, 0, 0, 4, 0, 0, 0, 200, 1, 2]))).toBeUndefined()
  // Metadata that is not JSON.
  const broken = Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from([0, 0, 0, 3]), Buffer.from('not', 'utf8')])
  expect(preview(new Uint8Array(broken))).toBeUndefined()
})
