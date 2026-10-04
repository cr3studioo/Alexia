// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { afterAll, describe, expect, test } from 'vitest'
import { AttachmentCallContext } from '@alexia/protocol'
import { Attachments } from '../src/attachments/index.js'
import { inspect } from '../src/attachments/images.js'
import { Store, textOf } from '../src/store.js'

/**
 * Durable, conversation-scoped pictures (A02). What is tested is the set of promises the editor
 * stands on: a picture survives reload, belongs to one conversation, keeps its label for ever,
 * arrives without its metadata, and once deleted cannot be used, published or replayed again.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-attachments-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const chunk = (type: string, data: Buffer): Buffer => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
const png = (w: number, h: number, extra: Buffer[] = []): Buffer => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const jpeg = (w: number, h: number, orientation?: number): Buffer => {
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0])
  const parts = [Buffer.from([0xff, 0xd8])]
  if (orientation !== undefined) {
    const tiff = Buffer.alloc(26)
    tiff.write('MM', 0, 'latin1')
    tiff.writeUInt16BE(42, 2)
    tiff.writeUInt32BE(8, 4)
    tiff.writeUInt16BE(1, 8)
    tiff.writeUInt16BE(0x0112, 10)
    tiff.writeUInt16BE(3, 12)
    tiff.writeUInt32BE(1, 14)
    tiff.writeUInt16BE(orientation, 18)
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
    const app1 = Buffer.alloc(4)
    app1.writeUInt16BE(0xffe1, 0)
    app1.writeUInt16BE(body.length + 2, 2)
    parts.push(app1, body)
  }
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0, 7]), Buffer.from('hello', 'latin1')])
  parts.push(comment, sof, Buffer.from([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]))
  return Buffer.concat(parts)
}

const setup = () => {
  const dir = mkdtempSync(join(root, 'data-'))
  const store = new Store(join(dir, 'alexia.db'))
  const attachments = new Attachments(store, dir)
  const a = String(store.createSession('one'))
  const b = String(store.createSession('two'))
  return { dir, store, attachments, a, b }
}

describe('pictures as bytes', () => {
  test('format and size come from the bytes; metadata does not survive', () => {
    const marked = png(3, 2, [chunk('tEXt', Buffer.from('parameters\0secret prompt'))])
    const seen = inspect(marked)
    expect(seen).toMatchObject({ mime: 'image/png', width: 3, height: 2 })
    expect(seen.bytes.includes(Buffer.from('secret prompt'))).toBe(false)
    const j = inspect(jpeg(640, 480, 1))
    expect(j).toMatchObject({ mime: 'image/jpeg', width: 640, height: 480 })
    expect(j.bytes.includes(Buffer.from('Exif'))).toBe(false)
    expect(j.bytes.includes(Buffer.from('hello'))).toBe(false)
  })

  test('sideways, animated, damaged, oversized and non-pictures are refused', () => {
    expect(() => inspect(jpeg(10, 10, 6))).toThrow(/sideways/)
    expect(() => inspect(png(2, 2, [chunk('acTL', Buffer.alloc(8))]))).toThrow(/Animated/)
    const broken = png(2, 2)
    broken[20] = (broken[20] ?? 0) ^ 1
    expect(() => inspect(broken)).toThrow(/damaged/)
    expect(() => inspect(png(10_000, 10_000))).toThrow(/larger than Alexia opens/)
    expect(() => inspect(Buffer.from('%PDF-1.7'))).toThrow(/not a PNG, JPEG or WebP/)
  })
})

describe('records', () => {
  test('a picture survives a reload, with a label that is never reused', () => {
    const { dir, store, attachments, a } = setup()
    const first = attachments.ingest(a, { name: 'C:\\Users\\me\\holiday.png', bytes: png(4, 4) })
    const second = attachments.ingest(a, { name: 'outfit.png', bytes: png(4, 4) })
    expect([first.label, second.label]).toEqual(['image_1', 'image_2'])
    expect(first.displayName).toBe('holiday.png')
    attachments.revoke(a)
    attachments.cleanup(a, 'rev_1')
    const third = attachments.ingest(a, { name: 'new.png', bytes: png(4, 4) })
    expect(third.label).toBe('image_3')
    store.close()
    const reopened = new Attachments(new Store(join(dir, 'alexia.db')), dir)
    expect(reopened.list(a).map((x) => x.label)).toEqual(['image_3'])
  })

  test('files are named by opaque ids, never by what somebody called them', () => {
    const { attachments, a } = setup()
    const one = attachments.ingest(a, { name: '../../escape.png', bytes: png(2, 2) })
    const files = readdirSync(attachments.folder(a))
    expect(files).toEqual([`${one.id}.png`])
  })

  test('non-contiguous labels resolve; another conversation\'s do not', () => {
    const { attachments, a, b } = setup()
    for (let i = 0; i < 9; i++) attachments.ingest(a, { name: `${i}.png`, bytes: png(2, 2) })
    const context = attachments.resolve(a, ['image_7', 'image_9'])
    expect(AttachmentCallContext.parse(context).attachments.map((x) => x.label)).toEqual(['image_7', 'image_9'])
    expect(() => attachments.resolve(b, ['image_7'])).toThrow(/no image 7 in this conversation/)
    expect(() => attachments.lease(b, [context.attachments[0]!.id])).toThrow(/not in this conversation/)
    expect(() => attachments.resolve(a, ['image_7', 'image_7'])).toThrow(/twice/)
  })

  test('a link swapped in for a file is never followed', () => {
    const { attachments, a } = setup()
    const one = attachments.ingest(a, { name: 'x.png', bytes: png(2, 2) })
    const outside = join(root, 'secret.txt')
    writeFileSync(outside, 'secret')
    const path = join(attachments.folder(a), `${one.id}.png`)
    rmSync(path)
    symlinkSync(outside, path)
    expect(() => attachments.lease(a, [one.id])).toThrow(/cannot be read/)
  })

  test('a conversation that does not exist has no pictures', () => {
    const { attachments } = setup()
    expect(() => attachments.ingest('999', { name: 'x.png', bytes: png(2, 2) })).toThrow(/does not exist/)
    expect(() => attachments.ingest('not-a-number', { name: 'x.png', bytes: png(2, 2) })).toThrow(/conversation is needed/)
    expect(readdirSync(join(root)).length).toBeGreaterThan(0)
  })
})

describe('deletion', () => {
  test('revoking ends every lease at once, before any file is touched', () => {
    const { attachments, a } = setup()
    const one = attachments.ingest(a, { name: 'x.png', bytes: png(2, 2) })
    const lease = attachments.lease(a, [one.id])
    expect(attachments.isLive(lease.leaseId)).toBe(true)
    attachments.revoke(a)
    expect(attachments.isLive(lease.leaseId)).toBe(false)
    expect(existsSync(lease.attachments[0]!.path)).toBe(true)
    expect(() => attachments.lease(a, [one.id])).toThrow(/not in this conversation any more|deleted/)
  })

  test('cleanup removes the files and every inline picture the messages carried', () => {
    const { store, attachments, a } = setup()
    const one = attachments.ingest(a, { name: 'x.png', bytes: png(2, 2) })
    store.append(Number(a), { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', url: 'data:image/png;base64,AAAA' }] })
    attachments.revoke(a)
    const receipt = attachments.cleanup(a, 'rev_9')
    expect(receipt).toEqual({ revocationId: 'rev_9', local: 'complete', remote: [] })
    expect(existsSync(attachments.folder(a))).toBe(false)
    const [message] = store.history(Number(a))
    expect(JSON.stringify(message)).not.toContain('data:image')
    expect(textOf(message!)).toContain('A picture was here and has been deleted.')
    expect(attachments.list(a)).toEqual([])
    expect(() => attachments.describe(a, one.id)).toThrow()
  })

  test('released leases stop being live too', () => {
    const { attachments, a } = setup()
    const one = attachments.ingest(a, { name: 'x.png', bytes: png(2, 2) })
    const lease = attachments.lease(a, [one.id])
    attachments.release(lease.leaseId)
    expect(attachments.isLive(lease.leaseId)).toBe(false)
  })

  test('after a crash, orphans and unfinished deletions are collected', () => {
    const { store, attachments, a, b } = setup()
    const kept = attachments.ingest(a, { name: 'keep.png', bytes: png(2, 2) })
    writeFileSync(join(attachments.folder(a), 'att_orphan.png'), 'half-written')
    attachments.ingest(b, { name: 'gone.png', bytes: png(2, 2) })
    attachments.revoke(b)
    const deleted = String(store.createSession('deleted'))
    mkdirSync(attachments.folder(deleted), { recursive: true })
    writeFileSync(join(attachments.folder(deleted), 'att_x.png'), 'x')
    store.deleteSession(Number(deleted))
    expect(attachments.collect()).toBeGreaterThanOrEqual(2)
    expect(readdirSync(attachments.folder(a))).toEqual([`${kept.id}.png`])
    expect(existsSync(attachments.folder(b))).toBe(false)
    expect(existsSync(attachments.folder(deleted))).toBe(false)
    expect(readFileSync(join(attachments.folder(a), `${kept.id}.png`)).length).toBeGreaterThan(0)
  })
})
