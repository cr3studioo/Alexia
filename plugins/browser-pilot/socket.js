// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { TextDecoder } from 'node:util'
import { createServer } from 'node:http'

/**
 * The extension's way in: a WebSocket server (RFC 6455) on 127.0.0.1, written here on
 * `node:http`'s upgrade so the plugin has no dependency. Text frames only, 4 MiB a message.
 *
 * **Anything on this computer can reach 127.0.0.1**, so two things are the gate: the token the
 * owner pasted into the extension, and the extension id, pinned to the first one that showed a
 * valid token. Neither the token nor any frame's text is ever logged.
 */

export const MAX_MESSAGE = 4 * 1024 * 1024
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** How long a connection may sit before its hello. */
const HELLO_MS = 10_000

/** `chrome-extension://<id>` (Chrome, Edge) or `extension://<id>` (Edge), to the id; otherwise undefined. */
export function extensionId(origin) {
  const match = /^(?:chrome-extension|extension):\/\/([a-z0-9]{1,64})\/?$/i.exec(origin ?? '')
  return match?.[1]
}

const sameToken = (given, wanted) => {
  if (typeof given !== 'string' || typeof wanted !== 'string' || wanted === '') return false
  const a = Buffer.from(given)
  const b = Buffer.from(wanted)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** One frame, server to client: never masked. */
function frame(opcode, payload) {
  const length = payload.length
  const head =
    length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 0x10000 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(length)])
  return Buffer.concat([head, payload])
}

function bigLength(length) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(length))
  return b
}

const closePayload = (code, reason = '') => {
  const b = Buffer.alloc(2 + Buffer.byteLength(reason))
  b.writeUInt16BE(code)
  b.write(reason, 2)
  return b
}

/**
 * One open connection. Emits `message` (parsed JSON) and `close` ({ code, reason }).
 * `send(value)` writes one JSON text frame; `close(code, reason)` ends it.
 */
class Connection extends EventEmitter {
  #socket
  #buffer = Buffer.alloc(0)
  #parts = []
  #partBytes = 0
  #closed = false
  #decoder = new TextDecoder('utf-8', { fatal: true })

  constructor(socket, id) {
    super()
    this.id = id
    this.#socket = socket
    socket.on('data', (chunk) => this.#read(chunk))
    socket.on('error', () => socket.destroy())
    // `node:http` keeps a socket half open after the peer's end; nothing more will come, so go.
    socket.on('end', () => socket.destroy())
    socket.on('close', () => this.#gone(1006, ''))
  }

  send(value) {
    if (this.#closed) return false
    this.#socket.write(frame(0x1, Buffer.from(JSON.stringify(value))))
    return true
  }

  close(code = 1000, reason = '') {
    if (this.#closed) return
    this.#socket.write(frame(0x8, closePayload(code, reason)))
    this.#socket.end()
    // A client that never answers the close is not waited on for long.
    setTimeout(() => this.#socket.destroy(), 2000).unref()
    this.#gone(code, reason)
  }

  #gone(code, reason) {
    if (this.#closed) return
    this.#closed = true
    this.emit('close', { code, reason })
  }

  #read(chunk) {
    if (this.#closed) return
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    while (!this.#closed) {
      const b = this.#buffer
      if (b.length < 2) return
      const fin = (b[0] & 0x80) !== 0
      const opcode = b[0] & 0x0f
      const masked = (b[1] & 0x80) !== 0
      let length = b[1] & 0x7f
      let at = 2
      if (length === 126) {
        if (b.length < 4) return
        length = b.readUInt16BE(2)
        at = 4
      } else if (length === 127) {
        if (b.length < 10) return
        const big = b.readBigUInt64BE(2)
        length = big > BigInt(MAX_MESSAGE) ? Infinity : Number(big)
        at = 10
      }
      // RSV bits set, or a client frame that is not masked: both a broken peer.
      if ((b[0] & 0x70) !== 0 || !masked) return this.close(1002, 'protocol error')
      const control = opcode >= 0x8
      if (control && (!fin || length > 125)) return this.close(1002, 'protocol error')
      // Refused from the header alone, before a byte of the payload is held.
      if (!control && this.#partBytes + length > MAX_MESSAGE) return this.close(1009, 'message too big')
      if (b.length < at + 4 + length) return
      const mask = b.subarray(at, at + 4)
      const payload = Buffer.from(b.subarray(at + 4, at + 4 + length))
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      this.#buffer = b.subarray(at + 4 + length)
      this.#frame(fin, opcode, payload)
    }
  }

  #frame(fin, opcode, payload) {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000
      return this.close(code === 1005 || code === 1006 ? 1000 : code)
    }
    if (opcode === 0x9) return void this.#socket.write(frame(0xa, payload))
    if (opcode === 0xa) return
    if (opcode === 0x2) return this.close(1003, 'text frames only')
    const starts = opcode === 0x1
    if (starts === (this.#parts.length > 0) || (opcode !== 0x0 && opcode !== 0x1)) {
      return this.close(1002, 'protocol error')
    }
    this.#parts.push(payload)
    this.#partBytes += payload.length
    if (!fin) return
    const whole = Buffer.concat(this.#parts)
    this.#parts = []
    this.#partBytes = 0
    let value
    try {
      value = JSON.parse(this.#decoder.decode(whole))
    } catch {
      return this.close(1007, 'not JSON text')
    }
    this.emit('message', value)
  }
}

/**
 * Listen on 127.0.0.1 and hand over at most one connection that passed both gates.
 *
 * - `port` — the one to try; 0 for any. Taken by something else → any, and the caller remembers it.
 * - `token()` — the token as it stands now.
 * - `pinned()` / `pin(id)` — the extension id that is allowed; undefined until the first valid hello.
 * - `onConnect(conn)` — after `{"ok":true}` went out. `conn.on('close')` says when it ends.
 */
export async function startSocket({ port = 0, token, pinned, pin, onConnect, helloMs = HELLO_MS }) {
  let current
  const server = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' }).end('Upgrade Required')
  })

  const refuse = (socket, status, text) => {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }

  server.on('upgrade', async (req, socket) => {
    socket.on('error', () => socket.destroy())
    const key = req.headers['sec-websocket-key']
    if (
      req.headers.upgrade?.toLowerCase() !== 'websocket' ||
      req.headers['sec-websocket-version'] !== '13' ||
      typeof key !== 'string' ||
      Buffer.from(key, 'base64').length !== 16
    ) {
      return refuse(socket, 400, 'Bad Request')
    }
    const id = extensionId(req.headers.origin)
    let allowed
    try {
      allowed = await pinned()
    } catch {
      return refuse(socket, 500, 'Internal Server Error')
    }
    if (id === undefined || (allowed !== undefined && id !== allowed)) return refuse(socket, 403, 'Forbidden')
    if (current) return refuse(socket, 409, 'Conflict')

    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const conn = new Connection(socket, id)
    current = conn
    conn.once('close', () => {
      if (current === conn) current = undefined
    })
    const late = setTimeout(() => conn.close(4001, 'bad token'), helloMs)
    conn.once('close', () => clearTimeout(late))
    let gone = false
    conn.once('close', () => {
      gone = true
    })
    conn.once('message', async (hello) => {
      clearTimeout(late)
      try {
        if (hello?.hello !== 1 || !sameToken(hello.token, token())) return conn.close(4001, 'bad token')
        // Pinned again here, after the await: the first valid hello wins, even against a racer.
        const now = await pinned()
        if (now !== undefined && now !== id) return conn.close(4003, 'wrong extension')
        if (now === undefined) await pin(id)
        if (gone) return
        conn.browser = hello.browser === 'edge' ? 'edge' : 'chrome'
        conn.send({ ok: true })
        onConnect(conn)
      } catch {
        conn.close(1011, 'internal error')
      }
    })
  })

  await new Promise((resolve, reject) => {
    const listen = (p) => {
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE' && p !== 0) return listen(0)
        reject(error)
      })
      server.listen(p, '127.0.0.1', () => {
        server.removeAllListeners('error')
        server.on('error', () => {})
        resolve()
      })
    }
    listen(port)
  })

  return {
    server,
    port: server.address().port,
    /** The connection as it stands, if any. */
    get current() {
      return current
    },
    close: () =>
      new Promise((resolve) => {
        current?.close(1001, 'going away')
        server.close(() => resolve())
      }),
  }
}
