// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { MAX_MESSAGE, extensionId, startSocket } from '../socket.js'
import { assert, test } from './harness.js'

const TOKEN = randomBytes(32).toString('base64url')
const EXT_A = 'abcdefghijklmnopabcdefghijklmnop'
const EXT_B = 'ponmlkjihgfedcbaponmlkjihgfedcba'

/** A server with an in-memory pin, and a list of the connections it handed over. */
async function serve(options = {}) {
  let pinnedId
  const connected = []
  const s = await startSocket({
    token: () => TOKEN,
    pinned: async () => pinnedId,
    pin: async (id) => void (pinnedId = id),
    onConnect: (c) => connected.push(c),
    ...options,
  })
  return { s, connected, pinned: () => pinnedId }
}

/** One client frame: always masked, as RFC 6455 requires of a client. */
function clientFrame(opcode, payload, { fin = true, length = payload.length } = {}) {
  const mask = randomBytes(4)
  const head =
    length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | length])
    : length < 0x10000 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, length >> 8, length & 0xff])
    : (() => {
        const b = Buffer.alloc(10)
        b[0] = (fin ? 0x80 : 0) | opcode
        b[1] = 0x80 | 127
        b.writeBigUInt64BE(BigInt(length), 2)
        return b
      })()
  const body = Buffer.from(payload)
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3]
  return Buffer.concat([head, mask, body])
}

/**
 * The test's own client: the HTTP upgrade by hand, then server frames parsed as they come.
 * `status` is the HTTP answer; `next()` the next frame; `closed` resolves when the socket ends.
 */
function client(port, options = {}) {
  const origin = 'origin' in options ? options.origin : `chrome-extension://${EXT_A}`
  const key = randomBytes(16).toString('base64')
  const sock = connect(port, '127.0.0.1')
  let buf = Buffer.alloc(0)
  let head
  const frames = []
  const wanting = []
  let resolveHead
  const headers = new Promise((r) => (resolveHead = r))
  const closed = new Promise((r) => sock.on('close', r))
  sock.on('error', () => {})
  const push = (f) => (wanting.length > 0 ? wanting.shift()(f) : frames.push(f))
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (!head) {
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      head = buf.subarray(0, end).toString()
      buf = buf.subarray(end + 4)
      resolveHead(head)
    }
    while (buf.length >= 2) {
      let length = buf[1] & 0x7f
      let at = 2
      if (length === 126) [length, at] = [buf.readUInt16BE(2), 4]
      else if (length === 127) [length, at] = [Number(buf.readBigUInt64BE(2)), 10]
      if (buf.length < at + length) return
      assert.equal(buf[1] & 0x80, 0, 'a server frame is never masked')
      push({ opcode: buf[0] & 0x0f, payload: buf.subarray(at, at + length) })
      buf = buf.subarray(at + length)
    }
  })
  sock.on('close', () => {
    resolveHead(head ?? '')
    while (wanting.length > 0) wanting.shift()(undefined)
  })
  const lines = [
    'GET / HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    ...(origin === undefined ? [] : [`Origin: ${origin}`]),
  ]
  sock.write(`${lines.join('\r\n')}\r\n\r\n`)
  return {
    key,
    status: headers.then((h) => Number(h.split(' ')[1])),
    headers,
    closed,
    next: () => (frames.length > 0 ? Promise.resolve(frames.shift()) : new Promise((r) => wanting.push(r))),
    send: (value) => sock.write(clientFrame(0x1, Buffer.from(JSON.stringify(value)))),
    raw: (bytes) => sock.write(bytes),
    end: () => sock.end(),
  }
}

const json = (f) => JSON.parse(f.payload.toString())
const closeOf = (f) => ({ code: f.payload.readUInt16BE(0), reason: f.payload.subarray(2).toString() })
const hello = (token = TOKEN) => ({ hello: 1, token, browser: 'chrome', version: '0.1.0' })

/** Open, say hello with the right token, and read the `{"ok":true}`. */
async function admitted(port, origin = `chrome-extension://${EXT_A}`) {
  const c = client(port, { origin })
  assert.equal(await c.status, 101)
  c.send(hello())
  assert.deepEqual(json(await c.next()), { ok: true })
  return c
}

test('extensionId reads both browsers and nothing else', () => {
  assert.equal(extensionId(`chrome-extension://${EXT_A}`), EXT_A)
  assert.equal(extensionId(`extension://${EXT_A}`), EXT_A)
  assert.equal(extensionId('https://evil.example'), undefined)
  assert.equal(extensionId(`chrome-extension://${EXT_A}.evil.example`), undefined)
  assert.equal(extensionId(undefined), undefined)
})

test('handshake_and_frames', { timeout: 30_000 }, async () => {
  const { s, connected, pinned } = await serve()
  try {
    const c = client(s.port)
    assert.equal(await c.status, 101)
    const want = createHash('sha1').update(`${c.key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    assert.match(await c.headers, new RegExp(`Sec-WebSocket-Accept: ${want.replace(/[+/]/g, '\\$&')}`))
    c.send(hello())
    assert.deepEqual(json(await c.next()), { ok: true })
    assert.equal(connected.length, 1)
    assert.equal(pinned(), EXT_A)
    const conn = connected[0]
    assert.equal(conn.browser, 'chrome')

    // Server → client, a message big enough for the 16-bit length.
    const big = 'x'.repeat(70_000)
    conn.send({ id: 1, do: 'read', args: { big } })
    assert.deepEqual(json(await c.next()), { id: 1, do: 'read', args: { big } })

    // Client → server, one message in two fragments with a ping between them.
    const got = new Promise((r) => conn.once('message', r))
    const text = Buffer.from(JSON.stringify({ id: 1, ok: true, result: { title: 'Ünïcode ✓', pad: 'y'.repeat(300) } }))
    c.raw(clientFrame(0x1, text.subarray(0, 10), { fin: false }))
    c.raw(clientFrame(0x9, Buffer.from('hi')))
    c.raw(clientFrame(0x0, text.subarray(10)))
    const pong = await c.next()
    assert.equal(pong.opcode, 0xa)
    assert.equal(pong.payload.toString(), 'hi')
    assert.equal((await got).result.title, 'Ünïcode ✓')

    // Client close is answered with a close, and the connection says it ended.
    const ended = new Promise((r) => conn.once('close', r))
    c.raw(clientFrame(0x8, Buffer.from([0x03, 0xe8])))
    const reply = await c.next()
    assert.equal(reply.opcode, 0x8)
    assert.equal(closeOf(reply).code, 1000)
    await ended
    assert.equal(s.current, undefined)
  } finally {
    await s.close()
  }
})

test('bad_token_closed_4001', { timeout: 30_000 }, async () => {
  const { s, connected, pinned } = await serve()
  try {
    const c = client(s.port)
    assert.equal(await c.status, 101)
    c.send(hello('not-the-token'))
    const f = await c.next()
    assert.equal(f.opcode, 0x8)
    assert.deepEqual(closeOf(f), { code: 4001, reason: 'bad token' })
    await c.closed
    assert.equal(connected.length, 0)
    // A bad token pins nothing.
    assert.equal(pinned(), undefined)

    // Neither is a first frame that is not a hello, nor no frame at all.
    const quiet = await serve({ helloMs: 200 })
    try {
      const q = client(quiet.s.port)
      assert.equal(await q.status, 101)
      assert.deepEqual(closeOf(await q.next()), { code: 4001, reason: 'bad token' })
    } finally {
      await quiet.s.close()
    }
  } finally {
    await s.close()
  }
})

test('wrong_origin_refused', { timeout: 30_000 }, async () => {
  const { s, connected } = await serve()
  try {
    for (const origin of ['https://evil.example', 'null', undefined, 'chrome-extension://']) {
      const c = client(s.port, { origin })
      assert.equal(await c.status, 403, `origin ${origin}`)
      await c.closed
    }
    // Edge's own scheme is let in.
    const edge = await admitted(s.port, `extension://${EXT_A}`)
    edge.end()
    assert.equal(connected.length, 1)
  } finally {
    await s.close()
  }
})

test('second_extension_id_refused', { timeout: 30_000 }, async () => {
  const { s, connected, pinned } = await serve()
  try {
    const a = await admitted(s.port, `chrome-extension://${EXT_A}`)
    assert.equal(pinned(), EXT_A)

    // Only one at a time, even for the pinned extension.
    const again = client(s.port, { origin: `chrome-extension://${EXT_A}` })
    assert.equal(await again.status, 409)

    // Another extension, with the right token, after the first has gone: still refused.
    const gone = new Promise((r) => connected[0].once('close', r))
    a.end()
    await gone
    const b = client(s.port, { origin: `chrome-extension://${EXT_B}` })
    assert.equal(await b.status, 403)
    await b.closed
    assert.equal(pinned(), EXT_A)

    // And the pinned one is welcome back.
    const back = await admitted(s.port, `chrome-extension://${EXT_A}`)
    back.end()
    assert.equal(connected.length, 2)
  } finally {
    await s.close()
  }
})

test('oversize_frame_closes', { timeout: 30_000 }, async () => {
  const { s, connected } = await serve()
  try {
    const c = await admitted(s.port)
    // The header alone says it is too big; the payload is never sent.
    const head = clientFrame(0x1, Buffer.alloc(0), { length: MAX_MESSAGE + 1 })
    c.raw(head.subarray(0, 14))
    const f = await c.next()
    assert.equal(f.opcode, 0x8)
    assert.equal(closeOf(f).code, 1009)
    await c.closed

    // Fragments that only add up to too much are refused too.
    const d = await admitted(s.port)
    const half = Buffer.alloc(MAX_MESSAGE / 2 + 1, 0x20)
    d.raw(clientFrame(0x1, half, { fin: false }))
    d.raw(clientFrame(0x0, half))
    assert.equal(closeOf(await d.next()).code, 1009)

    // A message of exactly the limit is fine.
    const e = await admitted(s.port)
    const conn = connected.at(-1)
    const got = new Promise((r) => conn.once('message', r))
    const pad = 'z'.repeat(MAX_MESSAGE - JSON.stringify({ id: 1, ok: true, p: '' }).length)
    e.send({ id: 1, ok: true, p: pad })
    assert.equal((await got).p.length, pad.length)
    e.end()
  } finally {
    await s.close()
  }
})

test('listens_on_loopback_only', { timeout: 30_000 }, async () => {
  const { s } = await serve()
  try {
    assert.equal(s.server.address().address, '127.0.0.1')
    // From any other address of this computer, nobody is there.
    const other = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)
    if (other) {
      const refused = await new Promise((resolve) => {
        const sock = connect(s.port, other.address)
        sock.once('connect', () => (sock.destroy(), resolve(false)))
        sock.once('error', () => resolve(true))
        sock.setTimeout(10_000, () => (sock.destroy(), resolve(true)))
      })
      assert.ok(refused, `reachable on ${other.address}`)
    }
  } finally {
    await s.close()
  }
})

test('a taken port falls back to any free one', { timeout: 30_000 }, async () => {
  const first = await serve()
  try {
    const second = await serve({ port: first.s.port })
    assert.notEqual(second.s.port, first.s.port)
    await second.s.close()
  } finally {
    await first.s.close()
  }
})
