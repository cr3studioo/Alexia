// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

/**
 * A Magic Wormhole mailbox server, just enough of one for the real `alexia-connect` to pair
 * two computers on this machine: the rendezvous messages `connect/tests/pairing.rs` answers
 * (`bind`, `list`, `allocate`, `claim`, `release`, `open`, `add`, `close`), over a WebSocket
 * written here because core depends on no WebSocket server.
 *
 * It is a port of that file's stub, and holds to the same rules: a nameplate and a mailbox
 * take two sides and no more (`crowded`), a claim outlives its connection, and a message
 * added to a mailbox goes to everybody listening, the sender too.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

interface Plate { mailbox: string; sides: Set<string> }
interface Box { messages: unknown[]; sides: Set<string>; listeners: Map<string, (text: string) => void> }

export interface Mailbox {
  /** `ws://127.0.0.1:<port>/v1`, what `ALEXIA_CONNECT_MAILBOX_URL` takes. */
  url: string
  /** Every message any client sent. */
  heard: Record<string, unknown>[]
  /** Nameplates a newcomer could still claim. */
  openNumbers(): number
  close(): Promise<void>
}

/** One text frame, server to client: never masked. */
function frame(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text)
  const length = payload.length
  const head = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const big = Buffer.alloc(8); big.writeBigUInt64BE(BigInt(length)); return big })()])
  return Buffer.concat([head, payload])
}

/** Reads client frames off a socket, unmasking them, and hands each whole message on. */
function reader(socket: Socket, onText: (text: string) => void, onClose: () => void): void {
  let buffered = Buffer.alloc(0)
  let pieces: Buffer[] = []
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    for (;;) {
      if (buffered.length < 2) return
      const fin = (buffered[0]! & 0x80) !== 0
      const opcode = buffered[0]! & 0x0f
      const masked = (buffered[1]! & 0x80) !== 0
      let length = buffered[1]! & 0x7f
      let at = 2
      if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); at = 4 }
      else if (length === 127) { if (buffered.length < 10) return; length = Number(buffered.readBigUInt64BE(2)); at = 10 }
      const need = at + (masked ? 4 : 0) + length
      if (buffered.length < need) return
      const mask = masked ? buffered.subarray(at, at + 4) : undefined
      const payload = Buffer.from(buffered.subarray(at + (masked ? 4 : 0), need))
      if (mask) for (let index = 0; index < payload.length; index++) payload[index]! ^= mask[index % 4]!
      buffered = buffered.subarray(need)
      if (opcode === 0x8) { if (!socket.destroyed) socket.end(frame('', 0x8)); onClose(); return }
      if (opcode === 0x9) { socket.write(frame(payload.toString('latin1'), 0xa)); continue }
      if (opcode === 0xa) continue
      pieces.push(payload)
      if (fin) {
        const whole = Buffer.concat(pieces)
        pieces = []
        onText(whole.toString('utf8'))
      }
    }
  })
  socket.on('close', onClose)
  socket.on('error', () => {})
}

export async function mailbox(): Promise<Mailbox> {
  let allocated = 0
  const plates = new Map<string, Plate>()
  const boxes = new Map<string, Box>()
  const heard: Record<string, unknown>[] = []
  const sockets = new Set<Socket>()

  const server = createServer((_request, response) => { response.writeHead(426).end() })
  server.on('upgrade', (request: IncomingMessage, socket: Socket) => {
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') { socket.destroy(); return }
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const say = (value: unknown): void => { if (!socket.destroyed) socket.write(frame(JSON.stringify(value))) }
    const send = (text: string): void => { if (!socket.destroyed) socket.write(frame(text)) }
    say({ type: 'welcome', welcome: {} })

    let side = ''
    reader(socket, (text) => {
      const ask = JSON.parse(text) as Record<string, unknown>
      say({ type: 'ack' })
      heard.push(ask)
      const named = (field: string): string => typeof ask[field] === 'string' ? ask[field] : ''
      switch (ask.type) {
        case 'bind': side = named('side'); break
        case 'list': say({ type: 'nameplates', nameplates: [...plates.keys()].map((id) => ({ id })) }); break
        case 'allocate': allocated++; say({ type: 'allocated', nameplate: String(allocated) }); break
        case 'claim': {
          const number = named('nameplate')
          let plate = plates.get(number)
          if (!plate) { plate = { mailbox: `mailbox-${plates.size + boxes.size + heard.length}`, sides: new Set() }; plates.set(number, plate) }
          if (plate.sides.size >= 2 && !plate.sides.has(side)) { say({ type: 'error', error: 'crowded', orig: ask }); break }
          plate.sides.add(side)
          say({ type: 'claimed', mailbox: plate.mailbox })
          break
        }
        case 'release': {
          const number = named('nameplate')
          const plate = plates.get(number)
          if (plate) { plate.sides.delete(side); if (plate.sides.size === 0) plates.delete(number) }
          say({ type: 'released' })
          break
        }
        case 'open': {
          const name = named('mailbox')
          let box = boxes.get(name)
          if (!box) { box = { messages: [], sides: new Set(), listeners: new Map() }; boxes.set(name, box) }
          if (box.sides.size >= 2 && !box.sides.has(side)) { say({ type: 'error', error: 'crowded', orig: ask }); break }
          box.sides.add(side)
          box.listeners.set(side, send)
          for (const message of box.messages) say(message)
          break
        }
        case 'add': {
          const said = { type: 'message', side, phase: ask.phase, body: ask.body, id: 'm' }
          const box = [...boxes.values()].find((one) => one.listeners.has(side))
          if (box) {
            box.messages.push(said)
            // To everybody listening, the sender too: the real server echoes.
            for (const listener of box.listeners.values()) listener(JSON.stringify(said))
          }
          break
        }
        case 'close': {
          boxes.get(named('mailbox'))?.listeners.delete(side)
          say({ type: 'closed' })
          break
        }
      }
    }, () => {
      // Gone without a word: it stops listening, and what it claimed stays claimed.
      for (const box of boxes.values()) box.listeners.delete(side)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `ws://127.0.0.1:${port}/v1`,
    heard,
    openNumbers: () => plates.size,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
