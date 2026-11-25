// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCourier, DAMAGED, MOST_CHUNK, STALE_PART_MS } from '../courier.js'
import { assert, test } from './harness.js'

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')
const b64 = (text) => Buffer.from(text).toString('base64')

/** A courier over a fresh temp area: `allowed` is the one opened folder, `downloads` the default. */
async function setup({ openFolders = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'courier-'))
  const allowed = join(base, 'allowed')
  const downloads = join(base, 'Downloads')
  const elsewhere = join(base, 'elsewhere')
  for (const dir of [allowed, downloads, elsewhere]) await mkdir(dir)
  const held = { list: [] }
  const courier = createCourier({
    roots: async () => (openFolders ? [pathToFileURL(allowed).href] : []),
    downloads: () => downloads,
    ledger: {
      get: async () => held.list,
      set: async (list) => {
        held.list = list
      },
    },
  })
  return { base, allowed, downloads, elsewhere, courier, held, cleanup: () => rm(base, { recursive: true, force: true }) }
}

/** Move a file from one courier to another in pieces of `size`, reading each and writing it. */
async function carry({ from, path, to, name, folder, size, hash }) {
  let offset = 0
  for (;;) {
    const piece = await from.readChunk({ path, offset, length: size })
    const bytes = Buffer.from(piece.data, 'base64')
    const written = await to.writeChunk({ name, folder, offset, data: piece.data, last: piece.eof, sha256: piece.eof ? hash : undefined })
    offset += bytes.length
    if (piece.eof) return written
  }
}

test('round_trip_3_chunks', async () => {
  const s = await setup()
  try {
    const body = randomBytes(MOST_CHUNK * 2 + 12345)
    const source = join(s.allowed, 'big.bin')
    await writeFile(source, body)
    const info = await s.courier.stat({ path: source })
    assert.equal(info.size, body.length)
    assert.equal(info.name, 'big.bin')
    assert.equal(info.sha256, sha(body))

    const first = await s.courier.readChunk({ path: source, offset: 0, length: MOST_CHUNK })
    assert.equal(first.eof, false)
    assert.equal(Buffer.from(first.data, 'base64').length, MOST_CHUNK)

    const out = await carry({ from: s.courier, path: source, to: s.courier, name: 'copy.bin', folder: s.allowed, size: MOST_CHUNK, hash: info.sha256 })
    assert.equal(out.path, join(s.allowed, 'copy.bin'))
    const arrived = await readFile(out.path)
    assert.equal(sha(arrived), sha(body))
    assert.deepEqual(arrived, body)
    assert.equal(existsSync(`${out.path}.part`), false)
    assert.deepEqual(s.held.list, [])
  } finally {
    await s.cleanup()
  }
})

test('default_folder_is_downloads', async () => {
  const s = await setup({ openFolders: false })
  try {
    const out = await s.courier.writeChunk({ name: 'hello.txt', offset: 0, data: b64('hi'), last: true })
    assert.equal(await readFile(join(s.downloads, 'hello.txt'), 'utf8'), 'hi')
    assert.equal(out.path, join(s.downloads, 'hello.txt'))
  } finally {
    await s.cleanup()
  }
})

test('bad_hash_keeps_nothing', async () => {
  const s = await setup()
  try {
    const data = b64('some bytes')
    await s.courier.writeChunk({ name: 'x.txt', folder: s.allowed, offset: 0, data, last: false })
    assert.ok(existsSync(join(s.allowed, 'x.txt.part')))
    await assert.rejects(
      s.courier.writeChunk({ name: 'x.txt', folder: s.allowed, offset: 10, data, last: true, sha256: 'a'.repeat(64) }),
      (error) => error.message === DAMAGED,
    )
    assert.deepEqual(await readdir(s.allowed), [])
    assert.deepEqual(s.held.list, [])
  } finally {
    await s.cleanup()
  }
})

test('never_overwrites', async () => {
  const s = await setup()
  try {
    const put = (text) => s.courier.writeChunk({ name: 'note.txt', folder: s.allowed, offset: 0, data: b64(text), last: true })
    const a = await put('one')
    const b = await put('two')
    const c = await put('three')
    assert.equal(a.path, join(s.allowed, 'note.txt'))
    assert.equal(b.path, join(s.allowed, 'note (2).txt'))
    assert.equal(c.path, join(s.allowed, 'note (3).txt'))
    assert.equal(await readFile(a.path, 'utf8'), 'one')
    assert.equal(await readFile(b.path, 'utf8'), 'two')
    assert.equal(await readFile(c.path, 'utf8'), 'three')
    assert.deepEqual((await readdir(s.allowed)).sort(), ['note (2).txt', 'note (3).txt', 'note.txt'])
  } finally {
    await s.cleanup()
  }
})

test('outside_roots_refused', async () => {
  const s = await setup()
  try {
    const secret = join(s.elsewhere, 'secret.txt')
    await writeFile(secret, 'private')
    await assert.rejects(s.courier.stat({ path: secret }), /outside the folders/)
    await assert.rejects(s.courier.readChunk({ path: secret, offset: 0, length: 5 }), /outside the folders/)
    await assert.rejects(s.courier.readChunk({ path: join(s.allowed, '..', 'elsewhere', 'secret.txt'), offset: 0, length: 5 }), /outside the folders/)
    await assert.rejects(s.courier.writeChunk({ name: 'a.txt', folder: s.elsewhere, offset: 0, data: 'AAAA', last: true }), /outside the folders/)
    await assert.rejects(
      s.courier.writeChunk({ name: 'a.txt', folder: join(s.allowed, '..', 'elsewhere'), offset: 0, data: 'AAAA', last: true }),
      /outside the folders/,
    )
    await assert.rejects(s.courier.writeChunk({ name: '../escape.txt', folder: s.allowed, offset: 0, data: 'AAAA', last: true }), /plain file name/)
    assert.deepEqual(await readdir(s.elsewhere), ['secret.txt'])
  } finally {
    await s.cleanup()
  }
})

test('nothing_opened_refuses_reads_and_folder_writes', async () => {
  const s = await setup({ openFolders: false })
  try {
    const file = join(s.allowed, 'f.txt')
    await writeFile(file, 'x')
    await assert.rejects(s.courier.stat({ path: file }), /No folder has been opened/)
    await assert.rejects(s.courier.writeChunk({ name: 'a.txt', folder: s.allowed, offset: 0, data: 'AAAA', last: true }), /No folder has been opened/)
  } finally {
    await s.cleanup()
  }
})

test('chunk_too_big_refused', async () => {
  const s = await setup()
  try {
    const file = join(s.allowed, 'f.bin')
    await writeFile(file, randomBytes(2 * MOST_CHUNK))
    await assert.rejects(s.courier.readChunk({ path: file, offset: 0, length: MOST_CHUNK + 1 }), /at most 1 MiB/)
    const ok = await s.courier.readChunk({ path: file, offset: 0, length: MOST_CHUNK })
    assert.equal(Buffer.from(ok.data, 'base64').length, MOST_CHUNK)
    const big = Buffer.alloc(MOST_CHUNK + 1).toString('base64')
    await assert.rejects(s.courier.writeChunk({ name: 'big.bin', folder: s.allowed, offset: 0, data: big, last: true }), /at most 1 MiB/)
    assert.deepEqual(await readdir(s.allowed), ['f.bin'])
  } finally {
    await s.cleanup()
  }
})

test('out_of_order_piece_refused', async () => {
  const s = await setup()
  try {
    const data = b64('abcd')
    await assert.rejects(s.courier.writeChunk({ name: 'o.txt', folder: s.allowed, offset: 4, data, last: false }), /start again/)
    await s.courier.writeChunk({ name: 'o.txt', folder: s.allowed, offset: 0, data, last: false })
    await assert.rejects(s.courier.writeChunk({ name: 'o.txt', folder: s.allowed, offset: 9, data, last: false }), /does not follow/)
  } finally {
    await s.cleanup()
  }
})

test('stale_parts_cleaned', async () => {
  const s = await setup()
  try {
    const data = b64('half')
    await s.courier.writeChunk({ name: 'old.bin', folder: s.allowed, offset: 0, data, last: false })
    await s.courier.writeChunk({ name: 'fresh.bin', folder: s.allowed, offset: 0, data, last: false })
    const foreign = join(s.allowed, 'browser.part')
    await writeFile(foreign, 'not ours')
    const longAgo = new Date(Date.now() - 2 * STALE_PART_MS)
    await utimes(join(s.allowed, 'old.bin.part'), longAgo, longAgo)
    await utimes(foreign, longAgo, longAgo)

    assert.equal(await s.courier.cleanStale(), 1)
    assert.equal(existsSync(join(s.allowed, 'old.bin.part')), false)
    assert.equal(existsSync(join(s.allowed, 'fresh.bin.part')), true)
    assert.equal(existsSync(foreign), true)
    assert.deepEqual(s.held.list, [join(s.allowed, 'fresh.bin.part')])
  } finally {
    await s.cleanup()
  }
})
