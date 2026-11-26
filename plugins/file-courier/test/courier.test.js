// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
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
  // `asked` replaces the answer to `roots/list` when a test needs it to change under the courier.
  const opened = { asked: () => (openFolders ? [pathToFileURL(allowed).href] : []) }
  const courier = createCourier({
    roots: async () => opened.asked(),
    downloads: () => downloads,
    // Like the real storage, which is across a wire: copies, and an answer a moment later.
    ledger: {
      get: async () => {
        const copy = structuredClone(held.list)
        await setImmediate()
        return copy
      },
      set: async (list) => {
        await setImmediate()
        held.list = structuredClone(list)
      },
    },
  })
  return { base, allowed, downloads, elsewhere, courier, held, opened, cleanup: () => rm(base, { recursive: true, force: true }) }
}

/** Move a file from one courier to another in pieces of `size`, reading each and writing it. */
async function carry({ from, path, to, name, folder, size, hash }) {
  let offset = 0
  let transfer
  for (;;) {
    const piece = await from.readChunk({ path, offset, length: size })
    const bytes = Buffer.from(piece.data, 'base64')
    const written = await to.writeChunk({
      name,
      folder,
      transfer,
      offset,
      data: piece.data,
      last: piece.eof,
      sha256: piece.eof ? hash : undefined,
    })
    transfer = written.transfer
    offset += bytes.length
    if (piece.eof) return written
  }
}

/**
 * Plant a link at `at` that leads out to `file`. Windows lets only some accounts link to a file,
 * so there the fallback is a junction to the file's folder, which any account may make.
 */
async function plantLink(file, at) {
  try {
    await symlink(file, at, 'file')
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
    await symlink(dirname(file), at, 'junction')
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
    assert.deepEqual((await readdir(s.allowed)).sort(), ['big.bin', 'copy.bin'])
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
    const first = await s.courier.writeChunk({ name: 'x.txt', folder: s.allowed, offset: 0, data, last: false })
    assert.ok(existsSync(first.path))
    assert.match(basename(first.path), /^x\.txt\.[0-9a-f]{24}\.alexia-part$/)
    const { transfer } = first
    await assert.rejects(
      s.courier.writeChunk({ name: 'x.txt', folder: s.allowed, transfer, offset: 10, data, last: true, sha256: 'a'.repeat(64) }),
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
    const begin = (name) => s.courier.writeChunk({ name, folder: s.allowed, offset: 0, data, last: false })
    const old = await begin('old.bin')
    const fresh = await begin('fresh.bin')
    const replaced = await begin('replaced.bin')
    // Someone else's file now sits where one of the parts was.
    const other = join(s.allowed, 'other')
    await writeFile(other, 'someone else')
    await rm(replaced.path)
    await link(other, replaced.path)
    const foreign = join(s.allowed, 'browser.part')
    await writeFile(foreign, 'not ours')
    const longAgo = new Date(Date.now() - 2 * STALE_PART_MS)
    for (const path of [old.path, replaced.path, foreign]) await utimes(path, longAgo, longAgo)

    assert.equal(await s.courier.cleanStale(), 1)
    assert.equal(existsSync(old.path), false)
    assert.equal(existsSync(fresh.path), true)
    assert.equal(await readFile(replaced.path, 'utf8'), 'someone else')
    assert.equal(await readFile(foreign, 'utf8'), 'not ours')
    assert.deepEqual(
      s.held.list.map((one) => one.part),
      [fresh.path],
    )
  } finally {
    await s.cleanup()
  }
})

test('existing_part_file_left_untouched', async () => {
  const s = await setup()
  try {
    // A browser keeps its half-done download as `<file>.part` next to where the file will be.
    const browsers = join(s.downloads, 'video.mp4.part')
    await writeFile(browsers, 'half a download')
    const put = (text, offset, more) => s.courier.writeChunk({ name: 'video.mp4', offset, data: b64(text), last: true, ...more })

    const whole = await put('one piece', 0)
    const first = await put('two ', 0, { last: false })
    assert.notEqual(first.path, browsers)
    const second = await put('pieces', 4, { transfer: first.transfer })
    await assert.rejects(put('bad', 0, { sha256: 'b'.repeat(64) }), (error) => error.message === DAMAGED)

    assert.equal(await readFile(browsers, 'utf8'), 'half a download')
    assert.equal(await readFile(whole.path, 'utf8'), 'one piece')
    assert.equal(await readFile(second.path, 'utf8'), 'two pieces')
    assert.deepEqual((await readdir(s.downloads)).sort(), ['video (2).mp4', 'video.mp4', 'video.mp4.part'])
  } finally {
    await s.cleanup()
  }
})

test('same_name_transfers_both_arrive_intact', async () => {
  const s = await setup()
  try {
    // The same length and piece sizes, so only the transfer id tells them apart; sent at once.
    const size = 70000
    const bodies = [randomBytes(3 * size), randomBytes(3 * size)]
    const send = (body, index, transfer) =>
      s.courier.writeChunk({
        name: 'same.bin',
        folder: s.allowed,
        transfer,
        offset: index * size,
        data: body.subarray(index * size, (index + 1) * size).toString('base64'),
        last: index === 2,
        sha256: index === 2 ? sha(body) : undefined,
      })
    const firsts = await Promise.all(bodies.map((body) => send(body, 0)))
    assert.notEqual(firsts[0].transfer, firsts[1].transfer)
    assert.notEqual(firsts[0].path, firsts[1].path)
    assert.equal(s.held.list.length, 2)
    await Promise.all(bodies.map((body, i) => send(body, 1, firsts[i].transfer)))
    const done = await Promise.all(bodies.map((body, i) => send(body, 2, firsts[i].transfer)))

    for (const [i, body] of bodies.entries()) assert.deepEqual(await readFile(done[i].path), body)
    assert.deepEqual((await readdir(s.allowed)).sort(), ['same (2).bin', 'same.bin'])
    assert.deepEqual(s.held.list, [])
  } finally {
    await s.cleanup()
  }
})

test('transfers_of_different_names_keep_their_ledger_entries', async () => {
  const s = await setup()
  try {
    const names = ['a', 'b', 'c', 'd']
    const firsts = await Promise.all(
      names.map((name) => s.courier.writeChunk({ name, folder: s.allowed, offset: 0, data: b64(name), last: false })),
    )
    assert.deepEqual(s.held.list.map((one) => one.id).sort(), firsts.map((one) => one.transfer).sort())
  } finally {
    await s.cleanup()
  }
})

test('piece_without_transfer_id_never_guesses', async () => {
  const s = await setup()
  try {
    const put = (text, offset, more) =>
      s.courier.writeChunk({ name: 'g.txt', folder: s.allowed, offset, data: b64(text), last: false, ...more })
    const a = await put('aaaa', 0)
    // Only one transfer can be meant, so the id may be left out.
    assert.equal((await put('AAAA', 4)).transfer, a.transfer)
    const b = await put('bbbbbbbb', 0)
    await assert.rejects(put('zz', 8, { last: true }), /Send the transfer id/)
    assert.equal(await readFile(a.path, 'utf8'), 'aaaaAAAA')
    assert.equal(await readFile(b.path, 'utf8'), 'bbbbbbbb')
    await assert.rejects(put('zz', 8, { transfer: 'no such transfer' }), /start again/)
    const done = await put('BB', 8, { transfer: b.transfer, last: true })
    assert.equal(await readFile(done.path, 'utf8'), 'bbbbbbbbBB')
  } finally {
    await s.cleanup()
  }
})

test('symlinked_part_path_refused', async () => {
  const s = await setup()
  try {
    const victim = join(s.elsewhere, 'victim.txt')
    await writeFile(victim, 'keep')
    const first = await s.courier.writeChunk({ name: 'l.txt', folder: s.allowed, offset: 0, data: b64('abcd'), last: false })
    await rm(first.path)
    await plantLink(victim, first.path)
    assert.equal((await lstat(first.path)).isSymbolicLink(), true)

    const { transfer } = first
    await assert.rejects(
      s.courier.writeChunk({ name: 'l.txt', folder: s.allowed, transfer, offset: 4, data: b64('evil'), last: true }),
      /replaced by something else/,
    )
    assert.equal(await readFile(victim, 'utf8'), 'keep')
    assert.deepEqual(await readdir(s.elsewhere), ['victim.txt'])
    assert.deepEqual(await readdir(s.allowed), [basename(first.path)])
    assert.deepEqual(s.held.list, [])
  } finally {
    await s.cleanup()
  }
})

test('hard_linked_part_refused', async () => {
  const s = await setup()
  try {
    const put = (name) => s.courier.writeChunk({ name, folder: s.allowed, offset: 0, data: b64('abcd'), last: false })
    const more = (name, transfer) =>
      s.courier.writeChunk({ name, folder: s.allowed, transfer, offset: 4, data: b64('evil'), last: true })

    // Another file put in the part's place.
    const victim = join(s.elsewhere, 'victim.txt')
    await writeFile(victim, 'keep')
    const swapped = await put('h.txt')
    await rm(swapped.path)
    await link(victim, swapped.path)
    await assert.rejects(more('h.txt', swapped.transfer), /replaced by something else/)
    assert.equal(await readFile(victim, 'utf8'), 'keep')

    // The part itself given a second name outside the folder.
    const named = await put('i.txt')
    const outside = join(s.elsewhere, 'outside.txt')
    await link(named.path, outside)
    await assert.rejects(more('i.txt', named.transfer), /replaced by something else/)
    assert.equal(await readFile(outside, 'utf8'), 'abcd')
  } finally {
    await s.cleanup()
  }
})

test('folder_swapped_for_a_link_gets_nothing', async () => {
  const s = await setup()
  try {
    const folder = join(s.allowed, 'sub')
    const first = await s.courier.writeChunk({ name: 'f.txt', folder, offset: 0, data: b64('abcd'), last: false })
    await rm(folder, { recursive: true })
    // 'junction' matters on Windows only; elsewhere this is an ordinary symlink.
    await symlink(s.elsewhere, folder, 'junction')
    const { transfer } = first
    await assert.rejects(
      s.courier.writeChunk({ name: 'f.txt', folder, transfer, offset: 4, data: b64('efgh'), last: true }),
      /outside the folders/,
    )
    assert.deepEqual(await readdir(s.elsewhere), [])
  } finally {
    await s.cleanup()
  }
})

test('folder_closed_before_naming_gets_no_file', async () => {
  const s = await setup()
  try {
    const first = await s.courier.writeChunk({ name: 'c.txt', folder: s.allowed, offset: 0, data: b64('abcd'), last: false })
    // Open when the last piece arrives, closed by the time the file would get its name.
    let asks = 0
    s.opened.asked = () => [pathToFileURL(++asks === 1 ? s.allowed : s.elsewhere).href]
    const { transfer } = first
    await assert.rejects(
      s.courier.writeChunk({ name: 'c.txt', folder: s.allowed, transfer, offset: 4, data: b64('efgh'), last: true }),
      /outside the folders/,
    )
    assert.equal(asks, 2)
    assert.deepEqual(await readdir(s.allowed), [basename(first.path)])
  } finally {
    await s.cleanup()
  }
})

test('child_named_with_two_dots_is_inside', async () => {
  const s = await setup()
  try {
    const folder = join(s.allowed, '..cache')
    const written = await s.courier.writeChunk({ name: 'c.txt', folder, offset: 0, data: b64('cached'), last: true })
    assert.equal(await readFile(join(folder, 'c.txt'), 'utf8'), 'cached')
    assert.equal((await s.courier.stat({ path: written.path })).size, 6)
    const file = join(s.allowed, '..notes')
    await writeFile(file, 'n')
    assert.equal((await s.courier.readChunk({ path: file, offset: 0, length: 1 })).data, b64('n'))
    // The step up itself still leaves the folder.
    await assert.rejects(
      s.courier.writeChunk({ name: 'c.txt', folder: join(s.allowed, '..'), offset: 0, data: 'AAAA', last: true }),
      /outside the folders/,
    )
  } finally {
    await s.cleanup()
  }
})

test('windows_reserved_names_refused', async () => {
  const s = await setup()
  try {
    const put = (name) => s.courier.writeChunk({ name, folder: s.allowed, offset: 0, data: b64('x'), last: true })
    await assert.rejects(put('CON.txt'), {
      message: 'Windows keeps the name "CON.txt" for itself, so a file cannot be called that. Use another name.',
    })
    const kept = ['CON', 'con', 'PRN.pdf', 'AUX.log', 'NUL', 'nul.tar.gz', 'COM1.txt', 'com0', 'LPT9', 'COM¹.txt', 'CONIN$', 'CON .txt']
    for (const name of kept) await assert.rejects(put(name), /Windows keeps the name/, name)
    assert.deepEqual(await readdir(s.allowed), [])
    const fine = ['console.txt', 'CONTRACT.pdf', 'com10.txt', 'my.con', 'null']
    for (const name of fine) await put(name)
    assert.deepEqual((await readdir(s.allowed)).sort(), [...fine].sort())
  } finally {
    await s.cleanup()
  }
})
